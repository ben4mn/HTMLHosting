const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'database/hosting.db');

// Ensure database directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db;

function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, async (err) => {
      if (err) {
        console.error('Error opening database:', err);
        reject(err);
        return;
      }

      console.log('Connected to SQLite database');

      try {
        await runMigrations();
        console.log('Database initialized successfully');
        resolve();
      } catch (migrationErr) {
        console.error('Migration error:', migrationErr);
        reject(migrationErr);
      }
    });
  });
}

// Helper to run a query as a promise
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// Helper to get all rows as a promise
function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function runMigrations() {
  // Check if table exists
  const tables = await allQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='hosted_files'");

  if (tables.length === 0) {
    // Create fresh table with correct schema
    await runQuery(`
      CREATE TABLE hosted_files (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        description TEXT DEFAULT '',
        upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        expiry_time DATETIME,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        access_count INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        upload_ip TEXT,
        user_agent TEXT,
        upload_type TEXT DEFAULT 'html',
        file_count INTEGER DEFAULT 1
      )
    `);

    // Create indexes
    await runQuery('CREATE INDEX IF NOT EXISTS idx_slug ON hosted_files(slug)');
    await runQuery('CREATE INDEX IF NOT EXISTS idx_expiry_time ON hosted_files(expiry_time)');
    await runQuery('CREATE INDEX IF NOT EXISTS idx_upload_ip ON hosted_files(upload_ip)');
    await runQuery('CREATE INDEX IF NOT EXISTS idx_archived ON hosted_files(archived)');

    console.log('Created hosted_files table with correct schema');
    return;
  }

  // Table exists - check if expiry_time has NOT NULL constraint
  const columns = await allQuery("PRAGMA table_info(hosted_files)");
  const expiryCol = columns.find(col => col.name === 'expiry_time');

  if (expiryCol && expiryCol.notnull === 1) {
    console.log('Migrating database: removing NOT NULL constraint from expiry_time...');

    // SQLite doesn't support ALTER COLUMN, so we need to recreate the table
    await runQuery('BEGIN TRANSACTION');

    try {
      // Create new table with correct schema
      await runQuery(`
        CREATE TABLE hosted_files_new (
          id TEXT PRIMARY KEY,
          slug TEXT UNIQUE NOT NULL,
          filename TEXT NOT NULL,
          original_name TEXT NOT NULL,
          description TEXT DEFAULT '',
          upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
          expiry_time DATETIME,
          file_path TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          access_count INTEGER DEFAULT 0,
          archived INTEGER DEFAULT 0,
          upload_ip TEXT,
          user_agent TEXT,
          upload_type TEXT DEFAULT 'html',
          file_count INTEGER DEFAULT 1
        )
      `);

      // Copy data from old table
      await runQuery(`
        INSERT INTO hosted_files_new
        SELECT id, slug, filename, original_name, description, upload_time, expiry_time,
               file_path, file_size, access_count, archived, upload_ip, user_agent,
               COALESCE(upload_type, 'html'), COALESCE(file_count, 1)
        FROM hosted_files
      `);

      // Drop old table
      await runQuery('DROP TABLE hosted_files');

      // Rename new table
      await runQuery('ALTER TABLE hosted_files_new RENAME TO hosted_files');

      // Recreate indexes
      await runQuery('CREATE INDEX IF NOT EXISTS idx_slug ON hosted_files(slug)');
      await runQuery('CREATE INDEX IF NOT EXISTS idx_expiry_time ON hosted_files(expiry_time)');
      await runQuery('CREATE INDEX IF NOT EXISTS idx_upload_ip ON hosted_files(upload_ip)');
      await runQuery('CREATE INDEX IF NOT EXISTS idx_archived ON hosted_files(archived)');

      await runQuery('COMMIT');
      console.log('Database migration completed successfully');
    } catch (err) {
      await runQuery('ROLLBACK');
      throw err;
    }
  } else {
    // Check for missing columns and add them
    const columnNames = columns.map(col => col.name);

    if (!columnNames.includes('upload_type')) {
      await runQuery('ALTER TABLE hosted_files ADD COLUMN upload_type TEXT DEFAULT "html"');
      console.log('Added upload_type column');
    }

    if (!columnNames.includes('file_count')) {
      await runQuery('ALTER TABLE hosted_files ADD COLUMN file_count INTEGER DEFAULT 1');
      console.log('Added file_count column');
    }

    // Ensure indexes exist
    await runQuery('CREATE INDEX IF NOT EXISTS idx_slug ON hosted_files(slug)');
    await runQuery('CREATE INDEX IF NOT EXISTS idx_expiry_time ON hosted_files(expiry_time)');
    await runQuery('CREATE INDEX IF NOT EXISTS idx_upload_ip ON hosted_files(upload_ip)');
    await runQuery('CREATE INDEX IF NOT EXISTS idx_archived ON hosted_files(archived)');
  }
}

function getDatabase() {
  return db;
}

function insertFile(fileData) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT INTO hosted_files
      (id, slug, filename, original_name, description, expiry_time, file_path, file_size, upload_ip, user_agent, upload_type, file_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      fileData.id,
      fileData.slug,
      fileData.filename,
      fileData.original_name,
      fileData.description || '',
      fileData.expiry_time,
      fileData.file_path,
      fileData.file_size,
      fileData.upload_ip,
      fileData.user_agent,
      fileData.upload_type || 'html',
      fileData.file_count || 1
    ], function(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ id: fileData.id, slug: fileData.slug, changes: this.changes });
    });

    stmt.finalize();
  });
}

function getFile(id) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM hosted_files WHERE id = ? AND (expiry_time IS NULL OR expiry_time > datetime("now"))',
      [id],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row);
      }
    );
  });
}

function getFileBySlug(slug) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM hosted_files WHERE slug = ? AND (expiry_time IS NULL OR expiry_time > datetime("now"))',
      [slug],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row);
      }
    );
  });
}

function checkSlugExists(slug) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id FROM hosted_files WHERE slug = ?',
      [slug],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(!!row);
      }
    );
  });
}

function getAllFiles(options = {}) {
  return new Promise((resolve, reject) => {
    const { search, limit, offset, includeExpired } = options;
    let query = 'SELECT * FROM hosted_files WHERE 1=1';
    const params = [];

    if (!includeExpired) {
      query += ' AND (expiry_time IS NULL OR expiry_time > datetime("now"))';
    }

    if (search) {
      query += ' AND (original_name LIKE ? OR description LIKE ? OR slug LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    query += ' ORDER BY upload_time DESC';

    if (limit) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    if (offset) {
      query += ' OFFSET ?';
      params.push(offset);
    }

    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function archiveFile(slug) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE hosted_files SET archived = ? WHERE slug = ?',
      [1, slug],
      function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ changes: this.changes });
      }
    );
  });
}

function unarchiveFile(slug) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE hosted_files SET archived = ? WHERE slug = ?',
      [0, slug],
      function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ changes: this.changes });
      }
    );
  });
}

function deleteFile(slug) {
  return new Promise((resolve, reject) => {
    db.get('SELECT file_path FROM hosted_files WHERE slug = ?', [slug], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      if (!row) {
        resolve({ changes: 0, filePath: null });
        return;
      }

      db.run('DELETE FROM hosted_files WHERE slug = ?', [slug], function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ changes: this.changes, filePath: row.file_path });
      });
    });
  });
}

function incrementAccessCount(id) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE hosted_files SET access_count = access_count + 1 WHERE id = ?',
      [id],
      function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ changes: this.changes });
      }
    );
  });
}

function getExpiredFiles() {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, file_path FROM hosted_files WHERE expiry_time <= datetime("now")',
      [],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows);
      }
    );
  });
}

function deleteExpiredFiles(ids) {
  return new Promise((resolve, reject) => {
    if (ids.length === 0) {
      resolve({ changes: 0 });
      return;
    }
    
    const placeholders = ids.map(() => '?').join(',');
    db.run(
      `DELETE FROM hosted_files WHERE id IN (${placeholders})`,
      ids,
      function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ changes: this.changes });
      }
    );
  });
}

function closeDatabase() {
  return new Promise((resolve) => {
    if (db) {
      db.close((err) => {
        if (err) {
          console.error('Error closing database:', err);
        } else {
          console.log('Database connection closed');
        }
        resolve();
      });
    } else {
      resolve();
    }
  });
}

module.exports = {
  initDatabase,
  getDatabase,
  insertFile,
  getFile,
  getFileBySlug,
  checkSlugExists,
  getAllFiles,
  archiveFile,
  unarchiveFile,
  deleteFile,
  incrementAccessCount,
  getExpiredFiles,
  deleteExpiredFiles,
  closeDatabase
};