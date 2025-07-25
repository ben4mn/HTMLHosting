const express = require('express');
const path = require('path');
const fs = require('fs');
const { getFile, incrementAccessCount } = require('../database');

const router = express.Router();

// Error page template
function getErrorPage(code, title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Error - HTML Hosting</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            line-height: 1.6;
            color: #333;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .error-container {
            background: white;
            padding: 3rem;
            border-radius: 15px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            text-align: center;
            max-width: 500px;
            width: 90%;
        }
        
        .error-code {
            font-size: 4rem;
            font-weight: bold;
            color: #e74c3c;
            margin-bottom: 1rem;
        }
        
        .error-title {
            font-size: 1.5rem;
            margin-bottom: 1rem;
            color: #2c3e50;
        }
        
        .error-message {
            color: #7f8c8d;
            margin-bottom: 2rem;
            font-size: 1.1rem;
        }
        
        .back-link {
            display: inline-block;
            background: #667eea;
            color: white;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: 500;
            transition: background 0.3s ease;
        }
        
        .back-link:hover {
            background: #5a6fd8;
        }
        
        @media (max-width: 600px) {
            .error-container {
                padding: 2rem;
            }
            
            .error-code {
                font-size: 3rem;
            }
            
            .error-title {
                font-size: 1.3rem;
            }
        }
    </style>
</head>
<body>
    <div class="error-container">
        <div class="error-code">${code}</div>
        <h1 class="error-title">${title}</h1>
        <p class="error-message">${message}</p>
        <a href="/" class="back-link">← Back to Upload</a>
    </div>
</body>
</html>`;
}

// Helper function to validate UUID format
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// View endpoint - serves HTML content
router.get('/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    
    // Validate UUID format
    if (!isValidUUID(fileId)) {
      return res.status(404).send(getErrorPage(404, '404 - Not Found', 'The requested file was not found.'));
    }
    
    // Get file info from database
    const fileInfo = await getFile(fileId);
    
    if (!fileInfo) {
      // Check if file existed but is expired
      const expiredFile = await checkExpiredFile(fileId);
      if (expiredFile) {
        return res.status(410).send(getErrorPage(410, '410 - Content Expired', 'This content has expired and is no longer available.'));
      }
      
      return res.status(404).send(getErrorPage(404, '404 - Not Found', 'The requested file was not found.'));
    }
    
    // Check if file exists on disk
    if (!fs.existsSync(fileInfo.file_path)) {
      console.error(`File not found on disk: ${fileInfo.file_path}`);
      return res.status(404).send(getErrorPage(404, '404 - Not Found', 'The requested file was not found.'));
    }
    
    // Increment access counter
    try {
      await incrementAccessCount(fileId);
    } catch (err) {
      console.error('Error incrementing access count:', err);
      // Continue serving the file even if counter update fails
    }
    
    // Set security headers for served HTML
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-Content-Type-Options': 'nosniff',
      'X-XSS-Protection': '1; mode=block',
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; connect-src *; media-src * data: blob:; object-src 'none'; base-uri 'self';"
    });
    
    // Serve the HTML file
    res.sendFile(path.resolve(fileInfo.file_path));
    
    console.log(`File served: ${fileId} (access count: ${fileInfo.access_count + 1})`);
    
  } catch (error) {
    console.error('View error:', error);
    res.status(500).send(getErrorPage(500, '500 - Internal Server Error', 'An error occurred while retrieving the content.'));
  }
});

// Helper function to check if file existed but is expired
async function checkExpiredFile(fileId) {
  return new Promise((resolve) => {
    const { getDatabase } = require('../database');
    const db = getDatabase();
    
    db.get(
      'SELECT id FROM hosted_files WHERE id = ? AND expiry_time <= datetime("now")',
      [fileId],
      (err, row) => {
        if (err) {
          console.error('Error checking expired file:', err);
          resolve(null);
          return;
        }
        resolve(row);
      }
    );
  });
}

// Info endpoint - returns metadata about a file
router.get('/:id/info', async (req, res) => {
  try {
    const fileId = req.params.id;
    
    if (!isValidUUID(fileId)) {
      return res.status(404).json({
        error: 'File not found'
      });
    }
    
    const fileInfo = await getFile(fileId);
    
    if (!fileInfo) {
      return res.status(404).json({
        error: 'File not found'
      });
    }
    
    // Return public metadata (don't expose sensitive info)
    res.json({
      id: fileInfo.id,
      original_name: fileInfo.original_name,
      upload_time: fileInfo.upload_time,
      expiry_time: fileInfo.expiry_time,
      file_size: fileInfo.file_size,
      access_count: fileInfo.access_count
    });
    
  } catch (error) {
    console.error('Info error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

module.exports = router;