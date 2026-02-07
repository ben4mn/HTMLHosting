/**
 * API Key authentication middleware for HTMLHosting
 */
const crypto = require('crypto');

/**
 * Get valid API keys from environment variable
 * Format: API_KEYS=key1,key2,key3
 */
function getValidApiKeys() {
  const keys = process.env.API_KEYS || '';
  return keys.split(',').filter(k => k.trim().length > 0).map(k => k.trim());
}

/**
 * Hash API key for secure storage/comparison
 */
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Authentication middleware - validates API key from header
 * Accepts: X-API-Key header or Authorization: Bearer <key>
 */
function requireApiKey(req, res, next) {
  // Check X-API-Key header first
  let apiKey = req.headers['x-api-key'];

  // Fallback to Authorization: Bearer
  if (!apiKey && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      apiKey = parts[1];
    }
  }

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'API key required. Use X-API-Key header or Authorization: Bearer <key>'
    });
  }

  const validKeys = getValidApiKeys();

  if (validKeys.length === 0) {
    return res.status(503).json({
      success: false,
      error: 'API not configured. Set API_KEYS environment variable.'
    });
  }

  if (!validKeys.includes(apiKey)) {
    return res.status(403).json({
      success: false,
      error: 'Invalid API key'
    });
  }

  // Attach hashed key to request for ownership tracking
  req.apiKeyHash = hashApiKey(apiKey);
  req.apiKeyId = apiKey.substring(0, 8); // Truncated for logging

  next();
}

/**
 * Verify ownership of a resource
 * Must be used after requireApiKey middleware
 * Attaches fileInfo to req if authorized
 */
function createOwnershipVerifier(getFileBySlugRaw) {
  return async function verifyOwnership(req, res, next) {
    const { slug } = req.params;

    try {
      const fileInfo = await getFileBySlugRaw(slug);

      if (!fileInfo) {
        return res.status(404).json({
          success: false,
          error: 'File not found'
        });
      }

      // If file has api_key_hash, verify it matches the authenticated key
      // Files without api_key_hash (uploaded via web UI) can be modified by any API key
      if (fileInfo.api_key_hash && fileInfo.api_key_hash !== req.apiKeyHash) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to modify this file'
        });
      }

      req.fileInfo = fileInfo;
      next();
    } catch (error) {
      console.error('Ownership verification error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to verify ownership'
      });
    }
  };
}

module.exports = {
  requireApiKey,
  createOwnershipVerifier,
  hashApiKey,
  getValidApiKeys
};
