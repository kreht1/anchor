"""Model Lab inspector: reads a model file's structure and weight samples WITHOUT running code from it.

Pickled checkpoints (.pt/.pth/.ckpt/.pkl) are read with a locked-down unpickler: every class reference becomes an inert
stub that only records its name and state, so nothing in the file is imported or executed. torch is not needed.
Formats: PyTorch zip checkpoints, safetensors, numpy .npz/.npy, GGUF, ONNX and Keras .h5 (when onnx / h5py are installed).

  python model_inspect.py <file>                          -> structure (JSON)
  python model_inspect.py <file> --samples 16 < names.json -> weight samples for the named tensors (JSON)
"""
import json
import math
import os
import pickle
import struct
import sys
import zipfile
from collections import OrderedDict

import numpy as np

DT = {  # storage / dtype names -> numpy dtype, element size
    'FloatStorage': ('<f4', 4), 'DoubleStorage': ('<f8', 8), 'HalfStorage': ('<f2', 2), 'BFloat16Storage': ('bf16', 2),
    'LongStorage': ('<i8', 8), 'IntStorage': ('<i4', 4), 'ShortStorage': ('<i2', 2), 'CharStorage': ('i1', 1), 'ByteStorage': ('u1', 1),
    'BoolStorage': ('?', 1), 'float32': ('<f4', 4), 'float16': ('<f2', 2), 'bfloat16': ('bf16', 2), 'int64': ('<i8', 8), 'float64': ('<f8', 8),
    'F32': ('<f4', 4), 'F16': ('<f2', 2), 'BF16': ('bf16', 2), 'F64': ('<f8', 8), 'I64': ('<i8', 8), 'I32': ('<i4', 4), 'I16': ('<i2', 2), 'I8': ('i1', 1), 'U8': ('u1', 1), 'BOOL': ('?', 1),
}
NICE = {'<f4': 'float32', '<f8': 'float64', '<f2': 'float16', 'bf16': 'bfloat16', '<i8': 'int64', '<i4': 'int32', '<i2': 'int16', 'i1': 'int8', 'u1': 'uint8', '?': 'bool'}


def to_float(buf, dt):
    if dt == 'bf16':
        u = np.frombuffer(buf, dtype='<u2').astype(np.uint32) << 16
        return u.view(np.float32)
    return np.frombuffer(buf, dtype=dt).astype(np.float64 if dt == '<f8' else np.float32)


# ---------------------------------------------------------------- the safe unpickler
class Stub:
    """Any class the file mentions: records its dotted name, constructor args and state; never runs anything."""
    def __init__(self, path, args=()):
        self._path, self._args, self._state = path, args, None

    def __setstate__(self, s):
        self._state = s

    def __call__(self, *a, **k):
        return Stub(self._path, a)

    def __repr__(self):
        return f'<{self._path}>'


class StubClass:
    def __init__(self, path):
        self.path = path

    def __call__(self, *a, **k):
        return Stub(self.path, a)

    def __getattr__(self, name):  # e.g. class methods used as reducers
        return StubClass(self.path + '.' + name)


class Storage:
    def __init__(self, dtype, key, numel):
        self.dtype, self.key, self.numel = dtype, key, numel


class Tensor:
    def __init__(self, storage, offset, size, stride):
        self.storage, self.offset, self.shape, self.stride = storage, offset, tuple(int(x) for x in size), tuple(int(x) for x in stride)


def rebuild_tensor(storage, offset, size, stride, *rest):
    return Tensor(storage, offset, size, stride)


def rebuild_param(data, *rest):
    return data


class SafeUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module == 'torch._utils' and name in ('_rebuild_tensor_v2', '_rebuild_tensor', '_rebuild_tensor_v3'):
            return rebuild_tensor
        if module == 'torch._utils' and name.startswith('_rebuild_parameter'):
            return rebuild_param
        if module == 'torch._tensor' and name == '_rebuild_from_type_v2':  # (func, type, args, state): parameters saved by newer torch
            return lambda func, typ, args, state=None: func(*args) if callable(func) and not isinstance(func, StubClass) else (args[0] if args else None)
        if module == 'torch' and name.endswith('Storage'):
            return name
        if module == 'torch' and name in ('Size',):
            return tuple
        if module == 'collections' and name == 'OrderedDict':
            return OrderedDict
        if module == 'builtins' and name in ('set', 'frozenset', 'slice', 'complex', 'range'):
            return {'set': set, 'frozenset': frozenset, 'slice': slice, 'complex': complex, 'range': range}[name]
        if module == 'torch' and name in ('float32', 'float16', 'bfloat16', 'float64', 'int64', 'int32', 'uint8', 'bool'):
            return name
        return StubClass(f'{module}.{name}')

    def persistent_load(self, pid):
        # ('storage', storage_type, key, location, numel)
        if isinstance(pid, tuple) and pid and pid[0] == 'storage':
            st = pid[1]
            st = st if isinstance(st, str) else getattr(st, 'path', str(st)).split('.')[-1]
            return Storage(st, str(pid[2]), int(pid[4]) if len(pid) > 4 else 0)
        return None


# ---------------------------------------------------------------- walking what was loaded
def walk(obj, prefix, tensors, modules, depth=0, seen=None):
    seen = seen if seen is not None else set()
    if depth > 60 or id(obj) in seen:
        return
    if isinstance(obj, (Tensor,)):
        tensors.append((prefix, obj))
        return
    if isinstance(obj, np.ndarray):
        tensors.append((prefix, obj))
        return
    if isinstance(obj, (dict, OrderedDict)):
        seen.add(id(obj))
        for k, v in obj.items():
            walk(v, f'{prefix}.{k}' if prefix else str(k), tensors, modules, depth + 1, seen)
        return
    if isinstance(obj, (list, tuple)):
        seen.add(id(obj))
        if len(obj) < 5000:
            for i, v in enumerate(obj):
                walk(v, f'{prefix}.{i}' if prefix else str(i), tensors, modules, depth + 1, seen)
        return
    if isinstance(obj, Stub):
        seen.add(id(obj))
        modules[prefix or '(root)'] = obj._path
        st = obj._state
        if isinstance(st, tuple) and len(st) == 2 and isinstance(st[1], dict):
            st = {**(st[0] or {}), **st[1]} if isinstance(st[0], dict) else st[1]
        if isinstance(st, dict):
            for key in ('_parameters', '_buffers'):
                for k, v in (st.get(key) or {}).items():
                    walk(v, f'{prefix}.{k}' if prefix else k, tensors, modules, depth + 1, seen)
            for k, v in (st.get('_modules') or {}).items():
                walk(v, f'{prefix}.{k}' if prefix else k, tensors, modules, depth + 1, seen)
            for k, v in st.items():
                if not k.startswith('_') and isinstance(v, (dict, OrderedDict, Stub, Tensor)):
                    walk(v, f'{prefix}.{k}' if prefix else k, tensors, modules, depth + 1, seen)
        for i, a in enumerate(obj._args or ()):
            if isinstance(a, (Tensor, dict, OrderedDict, Stub)):
                walk(a, prefix, tensors, modules, depth + 1, seen)


# ---------------------------------------------------------------- readers
class Model:
    def __init__(self, path):
        self.path, self.format, self.tensors, self.modules, self.meta, self.notes = path, None, [], {}, {}, []
        self._read = None

    def info(self):
        rows, total, dtypes = [], 0, {}
        for name, t in self.tensors:
            shape = list(t.shape)
            n = int(np.prod(shape)) if shape else 1
            dt = self.dtype_of(t)
            rows.append({'name': name, 'shape': shape, 'dtype': dt, 'numel': n})
            if dt and not dt.startswith(('int', 'uint', 'bool')) and not name.endswith(('running_mean', 'running_var', 'num_batches_tracked')):
                total += n
            dtypes[dt] = dtypes.get(dt, 0) + n
        return {'format': self.format, 'file': self.path, 'size': os.path.getsize(self.path), 'tensors': rows[:20000], 'tensorCount': len(rows),
                'params': total, 'dtypes': dtypes, 'modules': self.modules, 'meta': self.meta, 'notes': self.notes}

    def dtype_of(self, t):
        if isinstance(t, np.ndarray):
            return str(t.dtype)
        if isinstance(t, Tensor):
            return NICE.get(DT.get(t.storage.dtype, ('?', 0))[0], t.storage.dtype)
        return getattr(t, 'dtype', '?')


def read_torch_zip(m):
    z = zipfile.ZipFile(m.path)
    pkl = next((n for n in z.namelist() if n.endswith('data.pkl')), None)
    if not pkl:
        raise ValueError('no data.pkl in the archive')
    prefix = pkl[: -len('data.pkl')]
    obj = SafeUnpickler(z.open(pkl)).load()
    walk(obj, '', m.tensors, m.modules)
    m.format = 'PyTorch checkpoint (zip)'
    if isinstance(obj, dict):
        m.meta = {k: (v if isinstance(v, (int, float, str, bool)) else type(v).__name__) for k, v in list(obj.items())[:40] if not isinstance(v, (dict, OrderedDict, Tensor, Stub))}

    def read(t, rows=None):
        dt, size = DT.get(t.storage.dtype, ('<f4', 4))
        with z.open(f'{prefix}data/{t.storage.key}') as f:
            n = int(np.prod(t.shape)) if t.shape else 1
            if rows is not None and len(t.shape) >= 1:
                n = min(n, rows * int(np.prod(t.shape[1:]) or 1))
            f.seek(t.offset * size)
            return to_float(f.read(n * size), dt), n
    m._read = read


def read_safetensors(m):
    with open(m.path, 'rb') as f:
        n = struct.unpack('<Q', f.read(8))[0]
        head = json.loads(f.read(n))
    base = 8 + n
    m.meta = head.pop('__metadata__', {}) or {}
    for name, d in head.items():
        t = Tensor(Storage(d['dtype'], name, 0), 0, d['shape'], ())
        t.range = (base + d['data_offsets'][0], base + d['data_offsets'][1])
        m.tensors.append((name, t))
    m.format = 'safetensors'

    def read(t, rows=None):
        dt, size = DT.get(t.storage.dtype, ('<f4', 4))
        a, b = t.range
        if rows is not None and len(t.shape) >= 1:
            b = min(b, a + rows * int(np.prod(t.shape[1:]) or 1) * size)
        with open(m.path, 'rb') as f:
            f.seek(a)
            buf = f.read(b - a)
        return to_float(buf, dt), len(buf) // size
    m._read = read


def read_numpy(m):
    if m.path.lower().endswith('.npy'):
        arr = np.load(m.path, mmap_mode='r', allow_pickle=False)
        m.tensors.append(('array', arr))
    else:
        z = np.load(m.path, allow_pickle=False)
        for k in z.files:
            m.tensors.append((k, z[k]))
    m.format = 'NumPy'
    m._read = lambda t, rows=None: (np.asarray(t[:rows] if rows else t, dtype=np.float64).ravel(), int(np.prod(t.shape)))


GGML = {0: ('F32', 4), 1: ('F16', 2), 30: ('BF16', 2)}


def read_gguf(m):
    with open(m.path, 'rb') as f:
        if f.read(4) != b'GGUF':
            raise ValueError('not a GGUF file')
        ver = struct.unpack('<I', f.read(4))[0]
        nt, nkv = struct.unpack('<QQ', f.read(16))

        def s():
            n = struct.unpack('<Q', f.read(8))[0]
            return f.read(n).decode('utf8', 'replace')
        SZ = {0: 'B', 1: 'b', 2: 'H', 3: 'h', 4: 'I', 5: 'i', 6: 'f', 7: '?', 10: 'Q', 11: 'q', 12: 'd'}

        def val(t):
            if t == 8:
                return s()
            if t == 9:
                at, n = struct.unpack('<IQ', f.read(12))
                out = [val(at) for _ in range(min(n, 64))]
                for _ in range(max(0, n - 64)):
                    val(at)
                return out if n <= 64 else f'[{n} items]'
            return struct.unpack('<' + SZ[t], f.read(struct.calcsize(SZ[t])))[0]
        for _ in range(nkv):
            k = s(); t = struct.unpack('<I', f.read(4))[0]
            v = val(t)
            if not isinstance(v, list) or len(str(v)) < 300:
                m.meta[k] = v
        infos = []
        for _ in range(nt):
            name = s(); nd = struct.unpack('<I', f.read(4))[0]
            dims = list(struct.unpack(f'<{nd}Q', f.read(8 * nd)))
            typ, off = struct.unpack('<IQ', f.read(12))
            infos.append((name, dims[::-1], typ, off))
        align = int(m.meta.get('general.alignment', 32))
        base = (f.tell() + align - 1) // align * align
    for name, shape, typ, off in infos:
        t = Tensor(Storage(GGML.get(typ, (f'ggml_type_{typ}', 0))[0], name, 0), 0, shape, ())
        t.range = (base + off, None)
        m.tensors.append((name, t))
    m.format = f'GGUF v{ver}'
    m.notes.append('Quantised tensors are listed with their shapes; weight samples are shown for F32/F16/BF16 tensors only.')

    def read(t, rows=None):
        dt, size = DT.get(t.storage.dtype, (None, 0))
        if not dt:
            raise ValueError('quantised tensor: no sample')
        n = int(np.prod(t.shape))
        if rows is not None:
            n = min(n, rows * int(np.prod(t.shape[1:]) or 1))
        with open(m.path, 'rb') as f:
            f.seek(t.range[0])
            return to_float(f.read(n * size), dt), n
    m._read = read


def read_onnx(m):
    import onnx  # optional
    from onnx import numpy_helper
    model = onnx.load(m.path)
    for init in model.graph.initializer:
        m.tensors.append((init.name, numpy_helper.to_array(init)))
    m.meta = {'ops': len(model.graph.node), 'producer': model.producer_name, 'opset': [o.version for o in model.opset_import][:3]}
    for node in model.graph.node:
        m.modules[node.name or node.output[0]] = node.op_type
    m.format = 'ONNX'
    m._read = lambda t, rows=None: (np.asarray(t[:rows] if rows else t, dtype=np.float64).ravel(), int(np.prod(t.shape)))


def read_h5(m):
    import h5py  # optional
    f = h5py.File(m.path, 'r')

    def visit(name, obj):
        if isinstance(obj, h5py.Dataset):
            m.tensors.append((name.replace('/', '.'), obj))
    f.visititems(visit)
    m.format = 'Keras / HDF5'
    m._read = lambda t, rows=None: (np.asarray(t[:rows] if rows else t[()], dtype=np.float64).ravel(), int(np.prod(t.shape)))


def read_pickle(m):
    with open(m.path, 'rb') as f:
        obj = SafeUnpickler(f).load()
    walk(obj, '', m.tensors, m.modules)
    m.format = 'pickle (structure only)'
    m.notes.append('Read with a locked-down unpickler: classes are recorded by name, nothing in the file was run.')
    m._read = None


def load(path):
    m = Model(path)
    low = path.lower()
    with open(path, 'rb') as f:
        head = f.read(8)
    try:
        if head[:2] == b'PK':
            read_torch_zip(m)
        elif low.endswith('.safetensors'):
            read_safetensors(m)
        elif low.endswith(('.npz', '.npy')):
            read_numpy(m)
        elif head[:4] == b'GGUF':
            read_gguf(m)
        elif low.endswith('.onnx'):
            read_onnx(m)
        elif low.endswith(('.h5', '.hdf5', '.keras')):
            read_h5(m)
        elif low.endswith(('.pkl', '.pickle', '.joblib')) or head[:1] == b'\x80':
            read_pickle(m)
        else:
            raise ValueError('unknown model format')
    except ImportError as e:
        raise ValueError(f'this format needs the Python package {e.name}')
    return m


def sample(m, name, cap):
    t = dict(m.tensors).get(name)
    if t is None:
        return {'name': name, 'error': 'not found'}
    if m._read is None:
        return {'name': name, 'error': 'no weights available for this format'}
    shape = list(t.shape)
    rows_needed = shape[0] if shape else 1
    vals, n = m._read(t, rows=min(rows_needed, 4096) if len(shape) >= 2 else None)
    vals = np.asarray(vals, dtype=np.float64)
    vals = vals[np.isfinite(vals)] if vals.size else vals
    out = {'name': name, 'shape': shape}
    if vals.size == 0:
        return {**out, 'error': 'empty'}
    out['stats'] = {'min': float(vals.min()), 'max': float(vals.max()), 'mean': float(vals.mean()), 'std': float(vals.std()), 'absMean': float(np.abs(vals).mean()),
                    'sampled': int(vals.size), 'zeros': float((vals == 0).mean())}
    hist, edges = np.histogram(vals, bins=48)
    out['hist'] = {'counts': hist.tolist(), 'lo': float(edges[0]), 'hi': float(edges[-1])}
    # a 2-D view: rows = output units (neurons / filters), cols = everything feeding each one
    r = shape[0] if len(shape) >= 2 else 1
    c = int(np.prod(shape[1:])) if len(shape) >= 2 else vals.size
    avail_rows = min(r, vals.size // max(c, 1)) if len(shape) >= 2 else 1
    if len(shape) >= 2 and avail_rows > 0:
        mat = vals[: avail_rows * c].reshape(avail_rows, c)
        ri = np.unique(np.linspace(0, avail_rows - 1, min(cap, avail_rows)).astype(int))
        ci = np.unique(np.linspace(0, c - 1, min(cap, c)).astype(int))
        out['matrix'] = {'rows': ri.tolist(), 'cols': ci.tolist(), 'values': np.round(mat[np.ix_(ri, ci)], 5).tolist(), 'totalRows': r, 'totalCols': c}
        out['rowNorm'] = np.round(np.linalg.norm(mat[ri], axis=1), 5).tolist()
        if len(shape) == 4:  # conv kernels: each filter averaged over its input channels
            k = mat.reshape(avail_rows, shape[1], shape[2], shape[3]).mean(axis=1)
            out['kernels'] = np.round(k[: min(48, avail_rows)], 4).tolist()
    elif len(shape) == 1:
        idx = np.unique(np.linspace(0, vals.size - 1, min(cap * 4, vals.size)).astype(int))
        out['vector'] = np.round(vals[idx], 5).tolist()
    return out


if __name__ == '__main__':
    path = sys.argv[1]
    try:
        m = load(path)
        if '--samples' in sys.argv:
            cap = int(sys.argv[sys.argv.index('--samples') + 1])
            names = json.loads(sys.stdin.read() or '[]')[:400]
            print(json.dumps({'samples': [sample(m, n, cap) for n in names]}))
        else:
            print(json.dumps(m.info()))
    except Exception as e:  # report, never crash with a traceback
        print(json.dumps({'error': f'{type(e).__name__}: {e}'}))
