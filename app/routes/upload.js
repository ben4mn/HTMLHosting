const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { insertFile, checkSlugExists, getAllFiles, archiveFile, unarchiveFile, deleteFile } = require('../database');

const router = express.Router();

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
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // Only allow HTML files
    const allowedMimes = ['text/html'];
    const allowedExtensions = ['.html', '.htm'];
    
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedMimes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only HTML files (.html, .htm) are allowed'), false);
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
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const file = req.file;
    const fileContent = file.buffer.toString('utf8');

    // Validate HTML content
    if (!validateHtmlContent(fileContent)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid HTML content'
      });
    }

    // Get optional fields from request body
    const { customSlug, description, duration } = req.body;

    // Determine slug
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
    const uploadDir = createUploadDirectory(uploadId);
    const filePath = path.join(uploadDir, 'index.html');

    // Write file to disk
    fs.writeFileSync(filePath, fileContent, 'utf8');

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
      file_path: filePath,
      file_size: file.size,
      upload_ip: clientIp,
      user_agent: userAgent
    };

    await insertFile(fileData);

    // Generate shareable URL
    const baseUrl = req.protocol + '://' + req.get('host');
    const shareableUrl = `${baseUrl}/${slug}`;

    res.json({
      success: true,
      id: uploadId,
      slug: slug,
      url: shareableUrl,
      filename: file.originalname,
      description: description || '',
      size: file.size,
      expiresAt: expiryTime,
      permanent: expiryTime === null
    });

    console.log(`File uploaded: ${slug} (${file.originalname}, ${file.size} bytes)`);
    
  } catch (error) {
    console.error('Upload error:', error);
    
    // Clean up file if it was created
    if (error.uploadId) {
      const uploadDir = path.join(__dirname, '../../uploads', error.uploadId);
      if (fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
    }
    
    if (error.message.includes('Only HTML files')) {
      return res.status(400).json({
        success: false,
        error: 'Only HTML files (.html, .htm) are allowed'
      });
    }
    
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File size exceeds 10MB limit'
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
        url: `${baseUrl}/${file.slug}`
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
        url: `${baseUrl}/${file.slug}`
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
        error: 'File size exceeds 10MB limit'
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