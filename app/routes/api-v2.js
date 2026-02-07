/**
 * API v2 Routes - Authenticated JSON API for AI agents
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const AdmZip = require('adm-zip');

const { requireApiKey, createOwnershipVerifier } = require('../middleware/auth');
const {
  isValidSlug,
  isReservedSlug,
  generateShortSlug,
  calculateExpiryTime,
  validateHtmlContent,
  sanitizeFilename
} = require('../utils/validation');
const {
  insertFile,
  checkSlugExists,
  getFileBySlug,
  getFileBySlugRaw,
  updateFile,
  deleteFile
} = require('../database');

const router = express.Router();

const BCRYPT_SALT_ROUNDS = 12;
const MAX_HTML_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ZIP_SIZE = 50 * 1024 * 1024; // 50MB

// Allowed file types for ZIP projects
const ALLOWED_EXTENSIONS = [
  '.html', '.htm', '.css', '.js', '.mjs',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.json', '.xml', '.txt', '.md', '.csv',
  '.mp3', '.mp4', '.webm', '.ogg', '.wav',
  '.map', '.webmanifest', '.manifest'
];

const BLOCKED_EXTENSIONS = [
  '.exe', '.dll', '.bat', '.cmd', '.sh', '.ps1', '.msi',
  '.php', '.py', '.rb', '.pl', '.cgi', '.asp', '.aspx', '.jsp',
  '.jar', '.class', '.war',
  '.htaccess', '.htpasswd', '.env', '.config', '.ini',
  '.sql', '.db', '.sqlite', '.mdb',
  '.pem', '.key', '.crt', '.pfx'
];

// Create ownership verifier with database function
const verifyOwnership = createOwnershipVerifier(getFileBySlugRaw);

// Rate limiting for API requests (configurable)
const apiRateWindow = parseInt(process.env.API_RATE_WINDOW) || 15 * 60 * 1000; // 15 minutes default
const apiRateMax = parseInt(process.env.API_RATE_LIMIT) || 100;

const apiLimiter = rateLimit({
  windowMs: apiRateWindow,
  max: apiRateMax,
  keyGenerator: (req) => req.apiKeyHash || req.ip,
  message: { success: false, error: 'Rate limit exceeded. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * GET /api/v2 - API Discovery endpoint (no auth required)
 */
router.get('/', (req, res) => {
  const baseUrl = req.protocol + '://' + req.get('host');

  res.json({
    name: 'HTMLHosting API v2',
    version: '2.0.0',
    description: 'Authenticated JSON API for programmatic HTML hosting',
    authentication: {
      type: 'API Key',
      header: 'X-API-Key or Authorization: Bearer <key>',
      required: true
    },
    rateLimit: {
      requests: apiRateMax,
      windowMs: apiRateWindow,
      windowMinutes: Math.round(apiRateWindow / 60000)
    },
    endpoints: [
      {
        method: 'GET',
        path: '/api/v2',
        description: 'API discovery - list all endpoints',
        auth: false
      },
      {
        method: 'POST',
        path: '/api/v2/upload',
        description: 'Create new HTML page or ZIP project',
        auth: true,
        body: {
          html: 'string (required for HTML upload) - raw HTML content',
          zip: 'string (required for ZIP upload) - base64-encoded ZIP file',
          slug: 'string (optional) - custom URL slug',
          description: 'string (optional) - page description',
          duration: 'string (optional) - 1day|30days|6months|permanent',
          password: 'string (optional) - password protect the page'
        },
        response: {
          success: true,
          id: 'uuid',
          slug: 'string',
          url: 'full URL to hosted page',
          size: 'number (bytes)',
          expiresAt: 'ISO date or null',
          permanent: 'boolean',
          passwordProtected: 'boolean',
          uploadType: 'html|zip',
          fileCount: 'number'
        }
      },
      {
        method: 'PUT',
        path: '/api/v2/upload/:slug',
        description: 'Update existing page (must be owner)',
        auth: true,
        body: {
          html: 'string (required for HTML) - new HTML content',
          zip: 'string (required for ZIP) - base64-encoded ZIP file',
          description: 'string (optional) - update description',
          duration: 'string (optional) - update expiry',
          password: 'string|null (optional) - set/remove password'
        }
      },
      {
        method: 'GET',
        path: '/api/v2/file/:slug',
        description: 'Get file metadata',
        auth: true,
        response: {
          success: true,
          file: {
            id: 'uuid',
            slug: 'string',
            url: 'full URL',
            size: 'number',
            uploadTime: 'ISO date',
            expiryTime: 'ISO date or null',
            permanent: 'boolean',
            expired: 'boolean',
            accessCount: 'number',
            archived: 'boolean',
            passwordProtected: 'boolean',
            isOwner: 'boolean'
          }
        }
      },
      {
        method: 'DELETE',
        path: '/api/v2/file/:slug',
        description: 'Delete file (must be owner)',
        auth: true
      },
      {
        method: 'GET',
        path: '/api/v2/check-slug/:slug',
        description: 'Check if a slug is available',
        auth: true,
        response: {
          available: 'boolean',
          reason: 'string or null'
        }
      }
    ],
    examples: {
      uploadHtml: {
        curl: `curl -X POST ${baseUrl}/api/v2/upload -H "X-API-Key: YOUR_KEY" -H "Content-Type: application/json" -d '{"html": "<html><body>Hello</body></html>", "slug": "my-page"}'`
      },
      uploadZip: {
        note: 'ZIP must be base64 encoded and contain index.html at root',
        curl: `curl -X POST ${baseUrl}/api/v2/upload -H "X-API-Key: YOUR_KEY" -H "Content-Type: application/json" -d '{"zip": "BASE64_ENCODED_ZIP", "slug": "my-project"}'`
      }
    }
  });
});

// Apply authentication to remaining routes
router.use(requireApiKey);
router.use(apiLimiter);

// Helper: Create upload directory
function createUploadDirectory(uploadId) {
  const uploadDir = path.join(__dirname, '../uploads', uploadId);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  return uploadDir;
}

// Helper: Check if file type is allowed/blocked
function isAllowedFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext) && !BLOCKED_EXTENSIONS.includes(ext);
}

function isBlockedFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return BLOCKED_EXTENSIONS.includes(ext);
}

// Helper: Check for macOS metadata files
function isMacOSMetadata(entryName) {
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('__MACOSX/') || normalized.includes('/__MACOSX/')) return true;
  const filename = normalized.split('/').pop();
  if (filename.startsWith('._')) return true;
  if (filename === '.DS_Store') return true;
  return false;
}

// Helper: Check for path traversal
function isPathSafe(entryName) {
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (normalized.includes('../') || normalized.includes('..\\')) return false;
  return true;
}

// Helper: Validate and extract ZIP file
function validateAndExtractZip(buffer, uploadDir) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const result = {
    valid: true,
    hasIndexHtml: false,
    fileCount: 0,
    totalSize: 0,
    errors: [],
    warnings: [],
    files: []
  };

  // Pre-extraction validation
  for (const entry of entries) {
    const entryName = entry.entryName;
    if (entry.isDirectory) continue;
    if (isMacOSMetadata(entryName)) continue;

    result.fileCount++;
    result.totalSize += entry.header.size;

    const lowerName = entryName.toLowerCase();
    if (lowerName === 'index.html' || lowerName.match(/^[^/]+\/index\.html$/)) {
      result.hasIndexHtml = true;
    }

    if (!isPathSafe(entryName)) {
      result.errors.push(`Invalid path: ${entryName}`);
      result.valid = false;
      continue;
    }

    if (isBlockedFileType(entryName)) {
      result.errors.push(`Blocked file type: ${entryName}`);
      result.valid = false;
      continue;
    }

    if (!isAllowedFileType(entryName)) {
      result.warnings.push(`Non-standard file type: ${entryName}`);
    }

    result.files.push({ name: entryName, size: entry.header.size });
  }

  if (!result.hasIndexHtml) {
    result.errors.push('ZIP must contain index.html at the root level');
    result.valid = false;
  }

  if (result.totalSize > MAX_ZIP_SIZE) {
    result.errors.push('Total extracted size exceeds 50MB limit');
    result.valid = false;
  }

  // Detect single top-level folder
  let commonPrefix = null;
  for (const file of result.files) {
    const parts = file.name.split('/');
    if (parts.length > 1) {
      const topFolder = parts[0] + '/';
      if (commonPrefix === null) {
        commonPrefix = topFolder;
      } else if (commonPrefix !== topFolder) {
        commonPrefix = null;
        break;
      }
    } else {
      commonPrefix = null;
      break;
    }
  }

  // Extract if valid
  if (result.valid) {
    try {
      if (commonPrefix) {
        for (const entry of entries) {
          if (entry.isDirectory) continue;
          if (isMacOSMetadata(entry.entryName)) continue;

          const entryName = entry.entryName;
          if (entryName.startsWith(commonPrefix)) {
            const newPath = entryName.substring(commonPrefix.length);
            if (newPath) {
              const targetPath = path.join(uploadDir, newPath);
              const targetDir = path.dirname(targetPath);
              if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
              }
              fs.writeFileSync(targetPath, entry.getData());
            }
          }
        }
      } else {
        zip.extractAllTo(uploadDir, true);
      }
    } catch (error) {
      result.errors.push(`Extraction failed: ${error.message}`);
      result.valid = false;
    }
  }

  return result;
}

/**
 * POST /api/v2/upload - Create new HTML page or ZIP project (JSON body)
 */
router.post('/upload', async (req, res) => {
  let uploadDir = null;

  try {
    const { html, zip, slug: customSlug, description, duration, password } = req.body;

    // Determine upload type
    const isZipUpload = !!zip;
    const isHtmlUpload = !!html;

    if (!isZipUpload && !isHtmlUpload) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: html (string) or zip (base64 string)'
      });
    }

    if (isZipUpload && isHtmlUpload) {
      return res.status(400).json({
        success: false,
        error: 'Provide either html or zip, not both'
      });
    }

    let totalSize, fileCount, uploadType;

    // Validate content based on type
    if (isHtmlUpload) {
      if (typeof html !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'html must be a string'
        });
      }

      if (!validateHtmlContent(html)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid HTML content. Must contain valid HTML structure.'
        });
      }

      totalSize = Buffer.byteLength(html, 'utf8');
      if (totalSize > MAX_HTML_SIZE) {
        return res.status(400).json({
          success: false,
          error: `HTML content exceeds ${MAX_HTML_SIZE / 1024 / 1024}MB limit`
        });
      }

      fileCount = 1;
      uploadType = 'html';
    } else {
      // ZIP upload
      if (typeof zip !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'zip must be a base64-encoded string'
        });
      }

      // Validate base64
      let zipBuffer;
      try {
        zipBuffer = Buffer.from(zip, 'base64');
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: 'Invalid base64 encoding for zip'
        });
      }

      if (zipBuffer.length > MAX_ZIP_SIZE) {
        return res.status(400).json({
          success: false,
          error: `ZIP file exceeds ${MAX_ZIP_SIZE / 1024 / 1024}MB limit`
        });
      }

      uploadType = 'zip';
    }

    // Determine slug
    let slug;
    if (customSlug && customSlug.trim()) {
      slug = customSlug.trim().toLowerCase();

      if (!isValidSlug(slug)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid slug format. Use only letters, numbers, hyphens, and underscores (max 100 chars)'
        });
      }

      if (isReservedSlug(slug)) {
        return res.status(400).json({
          success: false,
          error: 'This slug is reserved. Choose a different one.'
        });
      }

      const exists = await checkSlugExists(slug);
      if (exists) {
        return res.status(409).json({
          success: false,
          error: 'Slug already exists. Choose a different one or use PUT to update.'
        });
      }
    } else {
      // Generate random slug
      let attempts = 0;
      do {
        slug = generateShortSlug();
        attempts++;
      } while (await checkSlugExists(slug) && attempts < 10);

      if (attempts >= 10) {
        return res.status(500).json({
          success: false,
          error: 'Failed to generate unique slug. Please try again.'
        });
      }
    }

    // Create upload directory
    const uploadId = uuidv4();
    uploadDir = createUploadDirectory(uploadId);
    const indexPath = path.join(uploadDir, 'index.html');

    // Write content based on type
    if (isHtmlUpload) {
      fs.writeFileSync(indexPath, html, 'utf8');
    } else {
      // ZIP extraction
      const zipBuffer = Buffer.from(zip, 'base64');
      const validationResult = validateAndExtractZip(zipBuffer, uploadDir);

      if (!validationResult.valid) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
        return res.status(400).json({
          success: false,
          error: validationResult.errors.join('; ')
        });
      }

      totalSize = validationResult.totalSize;
      fileCount = validationResult.fileCount;

      if (validationResult.warnings.length > 0) {
        console.log(`ZIP upload warnings for ${slug}: ${validationResult.warnings.join(', ')}`);
      }
    }

    // Calculate expiry
    const expiryTime = calculateExpiryTime(duration || '30days');

    // Hash password if provided
    let passwordHash = null;
    if (password && password.trim()) {
      passwordHash = await bcrypt.hash(password.trim(), BCRYPT_SALT_ROUNDS);
    }

    // Client info
    const clientIp = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'API Client';

    // Save to database
    const fileData = {
      id: uploadId,
      slug: slug,
      filename: 'index.html',
      original_name: `api-upload-${slug}.${uploadType === 'zip' ? 'zip' : 'html'}`,
      description: description || '',
      expiry_time: expiryTime,
      file_path: indexPath,
      file_size: totalSize,
      upload_ip: clientIp,
      user_agent: userAgent,
      upload_type: uploadType,
      file_count: fileCount,
      password_hash: passwordHash,
      password_hint: null,
      api_key_hash: req.apiKeyHash
    };

    await insertFile(fileData);

    // Generate response
    const baseUrl = req.protocol + '://' + req.get('host');
    const shareableUrl = `${baseUrl}/${slug}/`;

    res.status(201).json({
      success: true,
      id: uploadId,
      slug: slug,
      url: shareableUrl,
      size: totalSize,
      expiresAt: expiryTime,
      permanent: expiryTime === null,
      passwordProtected: !!passwordHash,
      uploadType: uploadType,
      fileCount: fileCount
    });

    console.log(`API ${uploadType.toUpperCase()} upload: ${slug} (${fileCount} files, ${totalSize} bytes) by key ${req.apiKeyId}...`);

  } catch (error) {
    console.error('API upload error:', error);

    if (uploadDir && fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }

    res.status(500).json({
      success: false,
      error: 'Upload failed'
    });
  }
});

/**
 * PUT /api/v2/upload/:slug - Update existing page (HTML or ZIP)
 */
router.put('/upload/:slug', verifyOwnership, async (req, res) => {
  let newUploadDir = null;

  try {
    const { slug } = req.params;
    const { html, zip, description, duration, password } = req.body;
    const existingFile = req.fileInfo;

    // Determine upload type
    const isZipUpload = !!zip;
    const isHtmlUpload = !!html;

    if (!isZipUpload && !isHtmlUpload) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: html (string) or zip (base64 string)'
      });
    }

    if (isZipUpload && isHtmlUpload) {
      return res.status(400).json({
        success: false,
        error: 'Provide either html or zip, not both'
      });
    }

    let totalSize, fileCount, uploadType;

    // Validate content
    if (isHtmlUpload) {
      if (typeof html !== 'string' || !validateHtmlContent(html)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid HTML content'
        });
      }

      totalSize = Buffer.byteLength(html, 'utf8');
      if (totalSize > MAX_HTML_SIZE) {
        return res.status(400).json({
          success: false,
          error: `HTML content exceeds ${MAX_HTML_SIZE / 1024 / 1024}MB limit`
        });
      }

      fileCount = 1;
      uploadType = 'html';
    } else {
      // ZIP validation
      let zipBuffer;
      try {
        zipBuffer = Buffer.from(zip, 'base64');
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: 'Invalid base64 encoding for zip'
        });
      }

      if (zipBuffer.length > MAX_ZIP_SIZE) {
        return res.status(400).json({
          success: false,
          error: `ZIP file exceeds ${MAX_ZIP_SIZE / 1024 / 1024}MB limit`
        });
      }

      uploadType = 'zip';
    }

    // Delete old files from disk
    const oldUploadDir = path.dirname(existingFile.file_path);
    if (fs.existsSync(oldUploadDir)) {
      fs.rmSync(oldUploadDir, { recursive: true, force: true });
    }

    // Create new upload directory
    const newUploadId = uuidv4();
    newUploadDir = createUploadDirectory(newUploadId);
    const newIndexPath = path.join(newUploadDir, 'index.html');

    // Write content
    if (isHtmlUpload) {
      fs.writeFileSync(newIndexPath, html, 'utf8');
    } else {
      const zipBuffer = Buffer.from(zip, 'base64');
      const validationResult = validateAndExtractZip(zipBuffer, newUploadDir);

      if (!validationResult.valid) {
        fs.rmSync(newUploadDir, { recursive: true, force: true });
        return res.status(400).json({
          success: false,
          error: validationResult.errors.join('; ')
        });
      }

      totalSize = validationResult.totalSize;
      fileCount = validationResult.fileCount;
    }

    // Calculate new expiry if duration provided
    const expiryTime = duration ? calculateExpiryTime(duration) : existingFile.expiry_time;

    // Handle password update
    let passwordHash = existingFile.password_hash;
    if (password !== undefined) {
      if (password === null || password === '') {
        passwordHash = null; // Remove password
      } else {
        passwordHash = await bcrypt.hash(password.trim(), BCRYPT_SALT_ROUNDS);
      }
    }

    // Update database record
    const updateData = {
      id: newUploadId,
      file_path: newIndexPath,
      file_size: totalSize,
      description: description !== undefined ? description : existingFile.description,
      expiry_time: expiryTime,
      password_hash: passwordHash,
      upload_type: uploadType,
      file_count: fileCount
    };

    await updateFile(slug, updateData);

    // Generate response
    const baseUrl = req.protocol + '://' + req.get('host');

    res.json({
      success: true,
      id: newUploadId,
      slug: slug,
      url: `${baseUrl}/${slug}/`,
      size: totalSize,
      expiresAt: expiryTime,
      permanent: expiryTime === null,
      passwordProtected: !!passwordHash,
      uploadType: uploadType,
      fileCount: fileCount
    });

    console.log(`API ${uploadType.toUpperCase()} update: ${slug} (${fileCount} files, ${totalSize} bytes) by key ${req.apiKeyId}...`);

  } catch (error) {
    console.error('API update error:', error);

    if (newUploadDir && fs.existsSync(newUploadDir)) {
      fs.rmSync(newUploadDir, { recursive: true, force: true });
    }

    res.status(500).json({
      success: false,
      error: 'Update failed'
    });
  }
});

/**
 * GET /api/v2/file/:slug - Get file metadata
 */
router.get('/file/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const fileInfo = await getFileBySlugRaw(slug);

    if (!fileInfo) {
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }

    const baseUrl = req.protocol + '://' + req.get('host');

    // Check if expired
    let expired = false;
    if (fileInfo.expiry_time) {
      expired = new Date(fileInfo.expiry_time) <= new Date();
    }

    res.json({
      success: true,
      file: {
        id: fileInfo.id,
        slug: fileInfo.slug,
        url: `${baseUrl}/${fileInfo.slug}/`,
        originalName: fileInfo.original_name,
        description: fileInfo.description,
        size: fileInfo.file_size,
        uploadTime: fileInfo.upload_time,
        expiryTime: fileInfo.expiry_time,
        permanent: fileInfo.expiry_time === null,
        expired: expired,
        accessCount: fileInfo.access_count,
        archived: !!fileInfo.archived,
        passwordProtected: !!fileInfo.password_hash,
        isOwner: fileInfo.api_key_hash === req.apiKeyHash
      }
    });

  } catch (error) {
    console.error('API get file error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve file info'
    });
  }
});

/**
 * DELETE /api/v2/file/:slug - Delete file
 */
router.delete('/file/:slug', verifyOwnership, async (req, res) => {
  try {
    const { slug } = req.params;
    const fileInfo = req.fileInfo;

    // Delete from filesystem
    const uploadDir = path.dirname(fileInfo.file_path);
    if (fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }

    // Delete from database
    await deleteFile(slug);

    res.json({
      success: true,
      message: 'File deleted successfully'
    });

    console.log(`API delete: ${slug} by key ${req.apiKeyId}...`);

  } catch (error) {
    console.error('API delete error:', error);
    res.status(500).json({
      success: false,
      error: 'Delete failed'
    });
  }
});

/**
 * GET /api/v2/check-slug/:slug - Check if slug is available
 */
router.get('/check-slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    if (!isValidSlug(slug)) {
      return res.json({ available: false, reason: 'Invalid format' });
    }

    if (isReservedSlug(slug)) {
      return res.json({ available: false, reason: 'Reserved' });
    }

    const exists = await checkSlugExists(slug);
    res.json({ available: !exists, reason: exists ? 'Already taken' : null });
  } catch (error) {
    console.error('Check slug error:', error);
    res.status(500).json({ available: false, reason: 'Error checking availability' });
  }
});

module.exports = router;
