'use strict';
// Masks credentials before anything leaves the server. Transcripts can contain keys or webhook URLs that were pasted
// into a chat; the dashboard never shows them.
const PATTERNS = [
  /(?:https?:\/\/)?(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+(?:\/[\w-]*)?/gi,
  /sk-ant-[\w-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+\/-]{20,}=*/gi,
  /("?(?:api[_-]?key|secret|token|password|passwd|authToken|peerToken|access_token|refresh_token)"?\s*[:=]\s*"?)[^\s"',}]{8,}/gi,
];

function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (m, prefix) => (typeof prefix === 'string' && m.startsWith(prefix) ? prefix : '') + '‹redacted›');
  }
  return out;
}

module.exports = { redact };
