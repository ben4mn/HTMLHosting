const fs = require('fs');
const path = require('path');
const { getExpiredFiles, deleteExpiredFiles, initDatabase, closeDatabase } = require('./database');

async function cleanupExpiredFiles() {
  try {
    console.log('Starting cleanup process...');
    
    // Initialize database connection
    await initDatabase();
    
    // Get list of expired files
    const expiredFiles = await getExpiredFiles();
    
    if (expiredFiles.length === 0) {
      console.log('No expired files found.');
      return;
    }
    
    console.log(`Found ${expiredFiles.length} expired files to clean up.`);
    
    const deletedIds = [];
    let filesDeleted = 0;
    let errors = 0;
    
    // Delete files from filesystem
    for (const file of expiredFiles) {
      try {
        const uploadDir = path.dirname(file.file_path);
        
        // Check if directory exists
        if (fs.existsSync(uploadDir)) {
          // Remove the entire upload directory
          fs.rmSync(uploadDir, { recursive: true, force: true });
          deletedIds.push(file.id);
          filesDeleted++;
          console.log(`Deleted: ${file.id}`);
        } else {
          // File/directory doesn't exist, still remove from database
          deletedIds.push(file.id);
          console.log(`File already removed from filesystem: ${file.id}`);
        }
      } catch (error) {
        console.error(`Error deleting file ${file.id}:`, error.message);
        errors++;
      }
    }
    
    // Remove entries from database
    if (deletedIds.length > 0) {
      const result = await deleteExpiredFiles(deletedIds);
      console.log(`Removed ${result.changes} entries from database.`);
    }
    
    console.log(`Cleanup completed: ${filesDeleted} files deleted, ${errors} errors.`);
    
  } catch (error) {
    console.error('Cleanup process failed:', error);
    process.exit(1);
  } finally {
    // Close database connection
    await closeDatabase();
  }
}

// Function to get storage statistics
async function getStorageStats() {
  try {
    await initDatabase();
    const { getDatabase } = require('./database');
    const db = getDatabase();
    
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT 
          COUNT(*) as total_files,
          SUM(file_size) as total_size,
          COUNT(CASE WHEN expiry_time > datetime('now') THEN 1 END) as active_files,
          SUM(CASE WHEN expiry_time > datetime('now') THEN file_size ELSE 0 END) as active_size,
          COUNT(CASE WHEN expiry_time <= datetime('now') THEN 1 END) as expired_files,
          SUM(CASE WHEN expiry_time <= datetime('now') THEN file_size ELSE 0 END) as expired_size
        FROM hosted_files
      `, [], (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows[0]);
      });
    });
  } catch (error) {
    console.error('Error getting storage stats:', error);
    throw error;
  }
}

// Function to format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'stats':
      try {
        const stats = await getStorageStats();
        console.log('Storage Statistics:');
        console.log(`Total Files: ${stats.total_files}`);
        console.log(`Total Size: ${formatFileSize(stats.total_size || 0)}`);
        console.log(`Active Files: ${stats.active_files}`);
        console.log(`Active Size: ${formatFileSize(stats.active_size || 0)}`);
        console.log(`Expired Files: ${stats.expired_files}`);
        console.log(`Expired Size: ${formatFileSize(stats.expired_size || 0)}`);
      } catch (error) {
        console.error('Error getting stats:', error);
        process.exit(1);
      } finally {
        await closeDatabase();
      }
      break;
      
    case 'cleanup':
    case undefined:
      await cleanupExpiredFiles();
      break;
      
    default:
      console.log('Usage:');
      console.log('  node cleanup.js [command]');
      console.log('');
      console.log('Commands:');
      console.log('  cleanup   Clean up expired files (default)');
      console.log('  stats     Show storage statistics');
      process.exit(1);
  }
}

// Export functions for use in other modules
module.exports = {
  cleanupExpiredFiles,
  getStorageStats,
  formatFileSize
};

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}