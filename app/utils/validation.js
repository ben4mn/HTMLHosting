/**
 * Shared validation utilities for HTMLHosting API
 */

// Reserved slugs that conflict with routes
const RESERVED_SLUGS = ['api', 'health', 'list', 'admin', 'static', 'assets', 'css', 'js', 'images'];

/**
 * Validate slug is web-friendly (alphanumeric, hyphens, underscores)
 */
function isValidSlug(slug) {
  return /^[a-zA-Z0-9_-]+$/.test(slug) && slug.length >= 1 && slug.length <= 100;
}

/**
 * Check if slug is reserved
 */
function isReservedSlug(slug) {
  return RESERVED_SLUGS.includes(slug.toLowerCase());
}

/**
 * Generate a short random slug (8 characters)
 */
function generateShortSlug() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let slug = '';
  for (let i = 0; i < 8; i++) {
    slug += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return slug;
}

/**
 * Calculate expiry time based on duration option
 */
function calculateExpiryTime(duration) {
  if (duration === 'permanent') {
    return null;
  }

  const now = new Date();
  switch (duration) {
    case '1day':
      now.setDate(now.getDate() + 1);
      break;
    case '30days':
      now.setDate(now.getDate() + 30);
      break;
    case '6months':
      now.setMonth(now.getMonth() + 6);
      break;
    default:
      now.setDate(now.getDate() + 30); // Default to 30 days
  }
  return now.toISOString();
}

/**
 * Basic HTML validation - check for HTML structure
 */
function validateHtmlContent(content) {
  const htmlRegex = /<html[\s\S]*<\/html>|<!DOCTYPE[\s\S]*<html[\s\S]*<\/html>/i;
  return htmlRegex.test(content) || content.includes('<html') || content.includes('<!DOCTYPE');
}

/**
 * Sanitize filename to safe characters
 */
function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9.-]/g, '_');
}

module.exports = {
  RESERVED_SLUGS,
  isValidSlug,
  isReservedSlug,
  generateShortSlug,
  calculateExpiryTime,
  validateHtmlContent,
  sanitizeFilename
};
