PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_code TEXT NOT NULL UNIQUE,
  tool_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'ชิ้น',
  production_line TEXT NOT NULL DEFAULT '',
  process_machine TEXT NOT NULL DEFAULT '',
  storage_location TEXT NOT NULL DEFAULT '',
  photo_key TEXT,
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id INTEGER NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('IN', 'OUT', 'ADJUST')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  movement_date TEXT NOT NULL,
  reference_no TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tool_id) REFERENCES tools(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tools_code ON tools(tool_code);
CREATE INDEX IF NOT EXISTS idx_tools_line ON tools(production_line);
CREATE INDEX IF NOT EXISTS idx_movements_tool_date ON movements(tool_id, movement_date);
