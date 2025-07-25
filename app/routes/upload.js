const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { insertFile } = require('../database');

const router = express.Router();

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
  const uploadDir = path.join(__dirname, '../../uploads', uploadId);
  
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

    // Generate unique ID and create directory
    const uploadId = uuidv4();
    const uploadDir = createUploadDirectory(uploadId);
    const filePath = path.join(uploadDir, 'index.html');
    
    // Write file to disk
    fs.writeFileSync(filePath, fileContent, 'utf8');
    
    // Calculate expiry time (30 days from now)
    const expiryTime = new Date();
    expiryTime.setDate(expiryTime.getDate() + 30);
    
    // Get client info
    const clientIp = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
    const userAgent = req.headers['user-agent'] || '';
    
    // Save to database
    const fileData = {
      id: uploadId,
      filename: 'index.html',
      original_name: sanitizeFilename(file.originalname),
      expiry_time: expiryTime.toISOString(),
      file_path: filePath,
      file_size: file.size,
      upload_ip: clientIp,
      user_agent: userAgent
    };
    
    await insertFile(fileData);
    
    // Generate shareable URL
    const baseUrl = req.protocol + '://' + req.get('host');
    const shareableUrl = `${baseUrl}/view/${uploadId}`;
    
    res.json({
      success: true,
      id: uploadId,
      url: shareableUrl,
      filename: file.originalname,
      size: file.size,
      expiresAt: expiryTime.toISOString()
    });
    
    console.log(`File uploaded: ${uploadId} (${file.originalname}, ${file.size} bytes)`);
    
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

// Get recent files endpoint
router.get('/recent', async (req, res) => {
  try {
    const { getDatabase } = require('../database');
    const db = getDatabase();
    
    // Get recent files from last 24 hours, ordered by upload time
    const query = `
      SELECT id, original_name, upload_time, expiry_time, file_size, access_count
      FROM hosted_files 
      WHERE expiry_time > datetime('now')
      AND upload_time > datetime('now', '-1 day')
      ORDER BY upload_time DESC 
      LIMIT 20
    `;
    
    db.all(query, [], (err, rows) => {
      if (err) {
        console.error('Error fetching recent files:', err);
        return res.status(500).json({ error: 'Failed to fetch files' });
      }
      
      // Calculate days remaining for each file
      const files = rows.map(file => {
        const now = new Date();
        const expiry = new Date(file.expiry_time);
        const daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
        
        return {
          id: file.id,
          name: file.original_name,
          uploadTime: file.upload_time,
          expiryTime: file.expiry_time,
          fileSize: file.file_size,
          accessCount: file.access_count,
          daysRemaining: Math.max(0, daysRemaining),
          url: `${req.protocol}://${req.get('host')}/view/${file.id}`
        };
      });
      
      res.json({ files });
    });
    
  } catch (error) {
    console.error('Recent files error:', error);
    res.status(500).json({ error: 'Internal server error' });
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