const crypto = require('crypto');
const chatHandler = require('./chat');

const SESSION_COOKIE = 'aishin_uid';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function createUserId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function getExplicitUserId(req) {
  if (req.method === 'POST' && req.body && typeof req.body === 'object') {
    if (req.body.userId) return String(req.body.userId);
    if (req.body.user && req.body.user.id) return String(req.body.user.id);
  }
  if (req.query && req.query.userId) return String(req.query.userId);
  if (req.query && req.query.user) return String(req.query.user);
  return null;
}

module.exports = async (req, res) => {
  if (req.method === 'POST' && typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch (_) {
      // chat.js will return the normal validation/error response.
    }
  }

  const explicitUserId = getExplicitUserId(req);
  const cookies = parseCookies(req.headers && req.headers.cookie);
  const cookieUserId = cookies[SESSION_COOKIE] || null;
  const userId = explicitUserId || cookieUserId || createUserId();

  if (!explicitUserId && !cookieUserId) {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(userId)}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; HttpOnly; SameSite=Lax; Secure`
    );
  }

  if (req.method === 'POST' && req.body && typeof req.body === 'object') {
    req.body.userId = userId;
  } else {
    req.query = { ...(req.query || {}), userId };
  }

  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (payload && typeof payload === 'object' && payload.response === undefined && payload.reply !== undefined) {
      payload.response = payload.reply;
    }
    return originalJson(payload);
  };

  return chatHandler(req, res);
};
