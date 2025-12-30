const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { insertFile, checkSlugExists, getAllFiles, archiveFile, unarchiveFile, deleteFile } = require('../database');

const router = express.Router();

// Allowed file types for ZIP projects
const ALLOWED_EXTENSIONS = [
  // Web essentials
  '.html', '.htm', '.css', '.js', '.mjs',
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp',
  // Fonts
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  // Data files
  '.json', '.xml', '.txt', '.md', '.csv',
  // Media
  '.mp3', '.mp4', '.webm', '.ogg', '.wav',
  // Other web assets
  '.map', '.webmanifest', '.manifest'
];

// Dangerous file types to block
const BLOCKED_EXTENSIONS = [
  // Executables
  '.exe', '.dll', '.bat', '.cmd', '.sh', '.ps1', '.msi',
  // Server-side scripts
  '.php', '.py', '.rb', '.pl', '.cgi', '.asp', '.aspx', '.jsp',
  // Java
  '.jar', '.class', '.war',
  // Config files that could leak secrets
  '.htaccess', '.htpasswd', '.env', '.config', '.ini',
  // Database files
  '.sql', '.db', '.sqlite', '.mdb',
  // Other dangerous
  '.pem', '.key', '.crt', '.pfx'
];

// Check if file type is allowed
function isAllowedFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext) && !BLOCKED_EXTENSIONS.includes(ext);
}

// Check if file type is blocked
function isBlockedFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return BLOCKED_EXTENSIONS.includes(ext);
}

// Check if file is macOS metadata that should be skipped
function isMacOSMetadata(entryName) {
  const normalized = entryName.replace(/\\/g, '/');
  // Skip __MACOSX folder and ._ resource fork files
  if (normalized.startsWith('__MACOSX/') || normalized.includes('/__MACOSX/')) return true;
  const filename = normalized.split('/').pop();
  if (filename.startsWith('._')) return true;
  if (filename === '.DS_Store') return true;
  return false;
}

// Check if path is safe (no traversal)
function isPathSafe(entryName) {
  const normalized = entryName.replace(/\\/g, '/');

  // Block absolute paths
  if (normalized.startsWith('/')) return false;

  // Block path traversal
  if (normalized.includes('../') || normalized.includes('..\\')) return false;

  return true;
}

// Validate and extract ZIP file
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

  // Debug: log all entry names
  console.log('ZIP entries:', entries.map(e => e.entryName));

  // Pre-extraction validation
  for (const entry of entries) {
    const entryName = entry.entryName;

    // Skip directories
    if (entry.isDirectory) continue;

    // Skip macOS metadata files (__MACOSX, ._, .DS_Store)
    if (isMacOSMetadata(entryName)) {
      console.log('Skipping macOS metadata:', entryName);
      continue;
    }

    result.fileCount++;
    result.totalSize += entry.header.size;

    // Check for index.html at root OR in a single top-level folder
    const lowerName = entryName.toLowerCase();
    if (lowerName === 'index.html' || lowerName.match(/^[^/]+\/index\.html$/)) {
      result.hasIndexHtml = true;
      console.log('Found index.html:', entryName);
    }

    // Security: Path traversal check
    if (!isPathSafe(entryName)) {
      result.errors.push(`Invalid path: ${entryName}`);
      result.valid = false;
      continue;
    }

    // Security: Blocked file types
    if (isBlockedFileType(entryName)) {
      result.errors.push(`Blocked file type: ${entryName}`);
      result.valid = false;
      continue;
    }

    // Warning for non-standard file types
    if (!isAllowedFileType(entryName)) {
      result.warnings.push(`Non-standard file type: ${entryName}`);
    }

    result.files.push({
      name: entryName,
      size: entry.header.size
    });
  }

  // Must have index.html at root
  if (!result.hasIndexHtml) {
    result.errors.push('ZIP must contain index.html at the root level');
    result.valid = false;
  }

  // Total size check (50MB limit)
  if (result.totalSize > 50 * 1024 * 1024) {
    result.errors.push('Total extracted size exceeds 50MB limit');
    result.valid = false;
  }

  // Detect if all files are in a single top-level folder
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
      // File at root level, no common prefix
      commonPrefix = null;
      break;
    }
  }

  console.log('Common prefix detected:', commonPrefix);

  // Extract if valid
  if (result.valid) {
    try {
      if (commonPrefix) {
        // Extract files stripping the common prefix (single top-level folder)
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
              console.log('Extracted (stripped prefix):', entryName, '->', newPath);
            }
          }
        }
      } else {
        // Normal extraction
        zip.extractAllTo(uploadDir, true);
      }
    } catch (error) {
      result.errors.push(`Extraction failed: ${error.message}`);
      result.valid = false;
    }
  }

  return result;
}

// Generate a short random slug (8 characters)
function generateShortSlug() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let slug = '';
  for (let i = 0; i < 8; i++) {
    slug += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return slug;
}

// Validate slug is web-friendly (alphanumeric, hyphens, underscores)
function isValidSlug(slug) {
  return /^[a-zA-Z0-9_-]+$/.test(slug) && slug.length >= 1 && slug.length <= 100;
}

// Reserved slugs that conflict with routes
const RESERVED_SLUGS = ['api', 'health', 'list', 'admin', 'static', 'assets', 'css', 'js', 'images'];

function isReservedSlug(slug) {
  return RESERVED_SLUGS.includes(slug.toLowerCase());
}

// Calculate expiry time based on duration option
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

// Configure multer for file uploads
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit for ZIP files
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    // Allow HTML files
    const htmlMimes = ['text/html'];
    const htmlExts = ['.html', '.htm'];

    // Allow ZIP files
    const zipMimes = ['application/zip', 'application/x-zip-compressed', 'application/x-zip', 'application/octet-stream'];
    const zipExts = ['.zip'];

    if (htmlMimes.includes(file.mimetype) || htmlExts.includes(ext)) {
      req.uploadType = 'html';
      cb(null, true);
    } else if (zipMimes.includes(file.mimetype) || zipExts.includes(ext)) {
      req.uploadType = 'zip';
      cb(null, true);
    } else {
      cb(new Error('Only HTML files (.html, .htm) or ZIP projects (.zip) are allowed'), false);
    }
  }
});

// Helper function to create upload directory
function createUploadDirectory(uploadId) {
  const uploadDir = path.join(__dirname, '../uploads', uploadId);
  
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  
  return uploadDir;
}

// Helper function to validate HTML content (basic check)
function validateHtmlContent(content) {
  // Basic HTML validation - check for HTML structure
  const htmlRegex = /<html[\s\S]*<\/html>|<!DOCTYPE[\s\S]*<html[\s\S]*<\/html>/i;
  return htmlRegex.test(content) || content.includes('<html') || content.includes('<!DOCTYPE');
}

// Helper function to sanitize filename
function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9.-]/g, '_');
}

// Upload endpoint
router.post('/upload', upload.single('htmlfile'), async (req, res) => {
  let uploadDir = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const file = req.file;
    const uploadType = req.uploadType || 'html';

    // Get optional fields from request body
    const { customSlug, description, duration } = req.body;

    // Determine slug first (before any file operations)
    let slug;
    if (customSlug && customSlug.trim()) {
      slug = customSlug.trim().toLowerCase();

      // Validate custom slug format
      if (!isValidSlug(slug)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid URL format. Use only letters, numbers, hyphens, and underscores (max 100 characters)'
        });
      }

      // Check if reserved
      if (isReservedSlug(slug)) {
        return res.status(400).json({
          success: false,
          error: 'This URL is reserved. Please choose a different one.'
        });
      }

      // Check if slug already exists
      const slugExists = await checkSlugExists(slug);
      if (slugExists) {
        return res.status(400).json({
          success: false,
          error: 'This URL is already taken. Please choose a different one.'
        });
      }
    } else {
      // Generate random slug and ensure uniqueness
      let attempts = 0;
      do {
        slug = generateShortSlug();
        attempts++;
      } while (await checkSlugExists(slug) && attempts < 10);

      if (attempts >= 10) {
        return res.status(500).json({
          success: false,
          error: 'Failed to generate unique URL. Please try again.'
        });
      }
    }

    // Generate unique ID and create directory
    const uploadId = uuidv4();
    uploadDir = createUploadDirectory(uploadId);
    const indexPath = path.join(uploadDir, 'index.html');

    let fileCount = 1;
    let totalSize = file.size;

    if (uploadType === 'zip') {
      // ZIP file processing
      const validationResult = validateAndExtractZip(file.buffer, uploadDir);

      if (!validationResult.valid) {
        // Cleanup and return error
        fs.rmSync(uploadDir, { recursive: true, force: true });
        return res.status(400).json({
          success: false,
          error: validationResult.errors.join('; ')
        });
      }

      fileCount = validationResult.fileCount;
      totalSize = validationResult.totalSize;

      // Log warnings if any
      if (validationResult.warnings.length > 0) {
        console.log(`ZIP upload warnings for ${slug}: ${validationResult.warnings.join(', ')}`);
      }

    } else {
      // HTML file processing (existing logic)
      const fileContent = file.buffer.toString('utf8');

      if (!validateHtmlContent(fileContent)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
        return res.status(400).json({
          success: false,
          error: 'Invalid HTML content'
        });
      }

      // Apply 10MB limit for single HTML files
      if (file.size > 10 * 1024 * 1024) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
        return res.status(400).json({
          success: false,
          error: 'HTML file size exceeds 10MB limit'
        });
      }

      fs.writeFileSync(indexPath, fileContent, 'utf8');
    }

    // Calculate expiry time based on duration
    const expiryTime = calculateExpiryTime(duration || '30days');

    // Get client info
    const clientIp = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
    const userAgent = req.headers['user-agent'] || '';

    // Save to database
    const fileData = {
      id: uploadId,
      slug: slug,
      filename: 'index.html',
      original_name: sanitizeFilename(file.originalname),
      description: description || '',
      expiry_time: expiryTime,
      file_path: indexPath,
      file_size: totalSize,
      upload_ip: clientIp,
      user_agent: userAgent,
      upload_type: uploadType,
      file_count: fileCount
    };

    await insertFile(fileData);

    // Generate shareable URL
    const baseUrl = req.protocol + '://' + req.get('host');
    const shareableUrl = `${baseUrl}/${slug}/`;

    res.json({
      success: true,
      id: uploadId,
      slug: slug,
      url: shareableUrl,
      filename: file.originalname,
      description: description || '',
      size: totalSize,
      expiresAt: expiryTime,
      permanent: expiryTime === null,
      uploadType: uploadType,
      fileCount: fileCount
    });

    console.log(`${uploadType.toUpperCase()} uploaded: ${slug} (${file.originalname}, ${fileCount} files, ${totalSize} bytes)`);

  } catch (error) {
    console.error('Upload error:', error);

    // Clean up directory if it was created
    if (uploadDir && fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }

    if (error.message && error.message.includes('Only HTML files')) {
      return res.status(400).json({
        success: false,
        error: 'Only HTML files (.html, .htm) or ZIP projects (.zip) are allowed'
      });
    }

    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File size exceeds 50MB limit'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Upload failed'
    });
  }
});

// Get recent files endpoint (for landing page - last 5)
router.get('/recent', async (req, res) => {
  try {
    const files = await getAllFiles({ limit: 5 });
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const mappedFiles = files.map(file => {
      let daysRemaining = null;
      if (file.expiry_time) {
        const now = new Date();
        const expiry = new Date(file.expiry_time);
        daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      }

      return {
        id: file.id,
        slug: file.slug,
        name: file.original_name,
        description: file.description,
        uploadTime: file.upload_time,
        expiryTime: file.expiry_time,
        fileSize: file.file_size,
        accessCount: file.access_count,
        archived: !!file.archived,
        daysRemaining: daysRemaining,
        permanent: file.expiry_time === null,
        url: `${baseUrl}/${file.slug}/`
      };
    });

    res.json({ files: mappedFiles });
  } catch (error) {
    console.error('Recent files error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all files endpoint (for list page with search)
router.get('/files', async (req, res) => {
  try {
    const { search, limit, offset } = req.query;
    const files = await getAllFiles({
      search: search || '',
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined
    });
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const mappedFiles = files.map(file => {
      let daysRemaining = null;
      if (file.expiry_time) {
        const now = new Date();
        const expiry = new Date(file.expiry_time);
        daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      }

      return {
        id: file.id,
        slug: file.slug,
        name: file.original_name,
        description: file.description,
        uploadTime: file.upload_time,
        expiryTime: file.expiry_time,
        fileSize: file.file_size,
        accessCount: file.access_count,
        archived: !!file.archived,
        daysRemaining: daysRemaining,
        permanent: file.expiry_time === null,
        url: `${baseUrl}/${file.slug}/`
      };
    });

    res.json({ files: mappedFiles, total: mappedFiles.length });
  } catch (error) {
    console.error('Files list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Archive a file
router.post('/archive/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const result = await archiveFile(slug);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    res.json({ success: true, message: 'File archived successfully' });
  } catch (error) {
    console.error('Archive error:', error);
    res.status(500).json({ success: false, error: 'Failed to archive file' });
  }
});

// Unarchive a file
router.post('/unarchive/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const result = await unarchiveFile(slug);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    res.json({ success: true, message: 'File unarchived successfully' });
  } catch (error) {
    console.error('Unarchive error:', error);
    res.status(500).json({ success: false, error: 'Failed to unarchive file' });
  }
});

// Delete a file
router.delete('/file/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const result = await deleteFile(slug);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    // Delete the file from disk
    if (result.filePath) {
      const uploadDir = path.dirname(result.filePath);
      if (fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
    }

    res.json({ success: true, message: 'File deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete file' });
  }
});

// Check if slug is available
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

// Error handler for multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File size exceeds 50MB limit'
      });
    }

    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: 'Only one file allowed per upload'
      });
    }
  }

  next(error);
});

module.exports = router;