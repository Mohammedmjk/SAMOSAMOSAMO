import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'samo_warehouse.db');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const BACKUP_FILE = path.join(DATA_DIR, 'backup_store.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

let dbInstance: DatabaseSync | null = null;

export function resetDbInstance() {
  dbInstance = null;
}

export function recoverCorruptDatabase(): DatabaseSync {
  console.warn('⚠️ Initiating SQLite database recovery and restoration from backup...');
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (e) {
      console.warn('Error closing database instance during recovery:', e);
    }
    dbInstance = null;
  }

  ensureDataDir();

  const timestamp = Date.now();
  if (fs.existsSync(DB_FILE)) {
    try {
      const corruptBackup = path.join(DATA_DIR, `samo_warehouse.corrupt.${timestamp}.db`);
      fs.renameSync(DB_FILE, corruptBackup);
      console.log(`Corrupt database moved to ${corruptBackup}`);
    } catch (e) {
      console.warn('Could not rename corrupt DB file, removing instead:', e);
      try { fs.unlinkSync(DB_FILE); } catch {}
    }
  }

  const walFile = `${DB_FILE}-wal`;
  const shmFile = `${DB_FILE}-shm`;
  if (fs.existsSync(walFile)) {
    try { fs.unlinkSync(walFile); } catch {}
  }
  if (fs.existsSync(shmFile)) {
    try { fs.unlinkSync(shmFile); } catch {}
  }

  // Create fresh DB
  dbInstance = new DatabaseSync(DB_FILE);
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec('PRAGMA synchronous = NORMAL;');
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  dbInstance.exec('PRAGMA wal_autocheckpoint = 1000;');

  initSchema(dbInstance);
  seedIfEmpty(dbInstance, true);

  try {
    dbInstance.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {}

  console.log('✅ SQLite database recovery completed successfully!');
  return dbInstance;
}

export function getDb(): DatabaseSync {
  if (dbInstance) {
    return dbInstance;
  }

  ensureDataDir();

  try {
    dbInstance = new DatabaseSync(DB_FILE);

    // Safe high-performance pragmas
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA synchronous = NORMAL;');
    dbInstance.exec('PRAGMA foreign_keys = ON;');
    dbInstance.exec('PRAGMA wal_autocheckpoint = 1000;');

    // Verify database integrity
    const check = dbInstance.prepare('PRAGMA quick_check;').get() as any;
    const checkVal = check ? (check.quick_check || Object.values(check)[0]) : null;
    if (!check || (String(checkVal || '').toLowerCase() !== 'ok')) {
      console.warn('SQLite quick_check failed:', check);
      return recoverCorruptDatabase();
    }

    initSchema(dbInstance);
    seedIfEmpty(dbInstance, false);

    return dbInstance;
  } catch (err: any) {
    console.error('Failed to initialize SQLite database, attempting auto-recovery:', err);
    return recoverCorruptDatabase();
  }
}

function initSchema(db: DatabaseSync) {
  // 0. App metadata (for persistence & seed control)
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      val TEXT
    );
  `);

  // 1. Products table
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      barcode TEXT DEFAULT '',
      company TEXT DEFAULT '',
      quantity REAL DEFAULT 0,
      min_qty REAL DEFAULT 5,
      price REAL DEFAULT 0,
      total_price REAL DEFAULT 0,
      bonus REAL DEFAULT 0,
      expiry_date TEXT DEFAULT '',
      form TEXT DEFAULT '',
      image TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_company ON products(company);
  `);

  // 2. Staff table
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff (
      name TEXT PRIMARY KEY,
      email TEXT DEFAULT '',
      role TEXT DEFAULT 'staff',
      assigned_pharmacy TEXT DEFAULT '',
      assigned_pharmacy_phone TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    );
  `);

  try {
    db.exec(`ALTER TABLE staff ADD COLUMN email TEXT DEFAULT '';`);
  } catch {}
  try {
    db.exec(`ALTER TABLE staff ADD COLUMN role TEXT DEFAULT 'staff';`);
  } catch {}
  try {
    db.exec(`ALTER TABLE staff ADD COLUMN assigned_pharmacy TEXT DEFAULT '';`);
  } catch {}
  try {
    db.exec(`ALTER TABLE staff ADD COLUMN assigned_pharmacy_phone TEXT DEFAULT '';`);
  } catch {}

  // 3. Orders table
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      order_number TEXT PRIMARY KEY,
      checkout_id TEXT,
      pharmacy_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      staff_name TEXT DEFAULT '',
      total_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'قيد المراجعة',
      date TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      delivery_staff_name TEXT DEFAULT '',
      delivered_at TEXT DEFAULT '',
      user_id TEXT DEFAULT '',
      staff_email TEXT DEFAULT ''
    );
  `);

  // Migrate missing columns on orders table for existing databases
  try {
    const orderCols = db.prepare("PRAGMA table_info(orders)").all() as any[];
    const colNames = orderCols.map(c => c.name);
    if (!colNames.includes('checkout_id')) {
      db.exec('ALTER TABLE orders ADD COLUMN checkout_id TEXT;');
    }
    if (!colNames.includes('staff_email')) {
      db.exec('ALTER TABLE orders ADD COLUMN staff_email TEXT DEFAULT "";');
    }
    if (!colNames.includes('user_id')) {
      db.exec('ALTER TABLE orders ADD COLUMN user_id TEXT DEFAULT "";');
    }
    if (!colNames.includes('delivery_staff_name')) {
      db.exec('ALTER TABLE orders ADD COLUMN delivery_staff_name TEXT DEFAULT "";');
    }
    if (!colNames.includes('delivered_at')) {
      db.exec('ALTER TABLE orders ADD COLUMN delivered_at TEXT DEFAULT "";');
    }
  } catch (migErr) {
    console.warn('Orders column migration note:', migErr);
  }

  // Create indexes on orders table safely
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_pharmacy ON orders(pharmacy_name);
      CREATE INDEX IF NOT EXISTS idx_orders_staff_email ON orders(staff_email);
      CREATE UNIQUE INDEX IF NOT EXISTS orders_checkout_id_unique
      ON orders (checkout_id)
      WHERE checkout_id IS NOT NULL;
    `);
  } catch (idxErr) {
    console.warn('Orders index creation note:', idxErr);
  }

  // 3b. Staff Draft Invoices table
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_drafts (
      staff_email TEXT PRIMARY KEY,
      draft_data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 4. Order Details table (items in order)
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL,
      product_id TEXT DEFAULT '',
      product_name TEXT NOT NULL,
      barcode TEXT DEFAULT '',
      form TEXT DEFAULT '',
      quantity REAL DEFAULT 0,
      price REAL DEFAULT 0,
      total REAL DEFAULT 0,
      expiry_date TEXT DEFAULT '',
      FOREIGN KEY(order_number) REFERENCES orders(order_number) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_order_details_order ON order_details(order_number);
  `);

  // 5. Stock Movements table
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      product_id TEXT DEFAULT '',
      product_name TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity_before REAL DEFAULT 0,
      quantity_change REAL DEFAULT 0,
      quantity_after REAL DEFAULT 0,
      reason TEXT DEFAULT '',
      user TEXT DEFAULT '',
      order_number TEXT DEFAULT '',
      barcode TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_movements_prod ON stock_movements(product_id);
    CREATE INDEX IF NOT EXISTS idx_movements_order ON stock_movements(order_number);
  `);

  // 6. Pharmacies table (Approved pharmacies list)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pharmacies (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_pharmacies_name ON pharmacies(name);
  `);

  // 7. System Settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    );
  `);

  // 8. Inventory Logs table (Auditing all item adjustments & staff email)
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT DEFAULT '',
      product_name TEXT NOT NULL,
      action_type TEXT DEFAULT 'تعديل',
      qty_before REAL DEFAULT 0,
      qty_change REAL DEFAULT 0,
      qty_after REAL DEFAULT 0,
      price_before REAL DEFAULT 0,
      price_after REAL DEFAULT 0,
      staff_email TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inv_logs_prod ON inventory_logs(product_id);
    CREATE INDEX IF NOT EXISTS idx_inv_logs_staff ON inventory_logs(staff_email);
  `);

  // 9. Daily / Periodic Reports table
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL,
      total_sales REAL DEFAULT 0,
      orders_count INTEGER DEFAULT 0,
      pharmacies_count INTEGER DEFAULT 0,
      items_count INTEGER DEFAULT 0,
      generated_by_email TEXT DEFAULT '',
      summary_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(report_date);
  `);

  // Default system settings
  try {
    const insertSetting = db.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)');
    insertSetting.run('store_name', 'مذخر سامو الدوائي');
    insertSetting.run('store_phone', '07700000000');
    insertSetting.run('store_address', 'العراق - بغداد');
    insertSetting.run('invoice_note', 'شكراً لتعاملكم مع مذخر سامو الدوائي. يرجى تدقيق ومطابقة المواد والكميات عند الاستلام.');
    insertSetting.run('min_stock_alert', '5');
    insertSetting.run('admin_pin', '1234');
  } catch {}

  // Auto-seed pharmacies table from orders if table is empty
  try {
    const phCount = db.prepare('SELECT count(*) as cnt FROM pharmacies').get() as any;
    if (phCount && Number(phCount.cnt) === 0) {
      const distinctOrders = db.prepare("SELECT DISTINCT pharmacy_name, phone FROM orders WHERE TRIM(pharmacy_name) != ''").all() as any[];
      const insertPh = db.prepare('INSERT OR IGNORE INTO pharmacies (id, name, phone, address, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      const nowIso = new Date().toISOString();
      for (const row of distinctOrders) {
        const phName = String(row.pharmacy_name || '').trim();
        if (phName) {
          const phId = `PH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          insertPh.run(phId, phName, String(row.phone || '').trim(), '', '', nowIso);
        }
      }
      console.log(`Auto-seeded ${distinctOrders.length} pharmacies from existing orders.`);
    }
  } catch (e) {
    console.warn('Pharmacy auto-seed note:', e);
  }
}

function seedIfEmpty(db: DatabaseSync, force: boolean = false) {
  if (!force) {
    try {
      const isInit = db.prepare('SELECT val FROM app_meta WHERE key = ?').get('initialized') as { val: string } | undefined;
      if (isInit && isInit.val === '1') {
        return; // Already initialized in SQLite, never re-seed
      }
    } catch (e) {
      // continue
    }

    try {
      const countRow = db.prepare('SELECT count(*) as count FROM products').get() as { count: number };
      if (countRow && countRow.count > 0) {
        try {
          db.prepare('INSERT OR REPLACE INTO app_meta (key, val) VALUES (?, ?)').run('initialized', '1');
        } catch {}
        return; // Already seeded
      }
    } catch (e) {
      // table might be empty
    }
  }

  console.log('Seeding database from latest backup or seed file...');
  let seedData: any = null;

  const fileToUse = fs.existsSync(BACKUP_FILE) ? BACKUP_FILE : (fs.existsSync(SEED_FILE) ? SEED_FILE : null);
  if (fileToUse) {
    try {
      seedData = JSON.parse(fs.readFileSync(fileToUse, 'utf8'));
    } catch (err) {
      console.error('Failed to read seed/backup file:', err);
    }
  }

  if (!seedData) {
    console.warn('No seed file found, starting with empty tables');
    try {
      db.prepare('INSERT OR REPLACE INTO app_meta (key, val) VALUES (?, ?)').run('initialized', '1');
    } catch {}
    return;
  }

  // 1. Seed Products
  if (Array.isArray(seedData.products)) {
    const insertProd = db.prepare(`
      INSERT OR REPLACE INTO products 
      (id, name, barcode, company, quantity, min_qty, price, total_price, bonus, expiry_date, form, image, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMovement = db.prepare(`
      INSERT INTO stock_movements 
      (timestamp, product_id, product_name, type, quantity_before, quantity_change, quantity_after, reason, user, order_number, barcode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const nowStr = new Date().toLocaleString('ar-IQ');

    for (const p of seedData.products) {
      const id = String(p.id || `PROD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      const name = String(p.name || '').trim();
      if (!name) continue;
      const barcode = String(p.barcode || '').trim();
      const company = String(p.company || '').trim();
      const quantity = Number(p.quantity) || 0;
      const minQty = Number(p.minQty ?? p.min_qty) || 5;
      const price = Number(p.price) || 0;
      const totalPrice = Number(p.totalPrice ?? p.total_price) || (quantity * price);
      const bonus = Number(p.bonus) || 0;
      const expiryDate = String(p.expiryDate || p.expiry_date || '');
      const form = String(p.form || '');
      const image = String(p.image || '');
      const createdAt = String(p.createdAt || p.created_at || '');

      insertProd.run(id, name, barcode, company, quantity, minQty, price, totalPrice, bonus, expiryDate, form, image, createdAt);

      // Record opening stock if quantity > 0 and movements are not seeded separately
      if (quantity > 0 && (!Array.isArray(seedData.movements) || seedData.movements.length === 0)) {
        insertMovement.run(
          nowStr,
          id,
          name,
          'رصيد افتتاحي',
          0,
          quantity,
          quantity,
          'رصيد مخزون أولي مستورد من قاعدة البيانات الحالية',
          'النظام',
          '',
          barcode
        );
      }
    }
    console.log(`Seeded ${seedData.products.length} products`);
  }

  // 2. Seed Staff
  const staffList = Array.isArray(seedData.staffNames) && seedData.staffNames.length > 0 
    ? seedData.staffNames 
    : ['حسين', 'سجاد', 'أحمد', 'محمد', 'علي'];

  const insertStaff = db.prepare(`INSERT OR IGNORE INTO staff (name, created_at) VALUES (?, ?)`);
  const nowIso = new Date().toISOString();
  for (const s of staffList) {
    insertStaff.run(String(s).trim(), nowIso);
  }
  console.log(`Seeded ${staffList.length} staff members`);

  // 3. Seed Orders & Order Details
  if (Array.isArray(seedData.orders)) {
    const insertOrder = db.prepare(`
      INSERT OR REPLACE INTO orders
      (order_number, pharmacy_name, phone, staff_name, total_amount, status, date, created_at, delivery_staff_name, delivered_at, user_id, staff_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertDetail = db.prepare(`
      INSERT INTO order_details
      (order_number, product_id, product_name, barcode, form, quantity, price, total, expiry_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const o of seedData.orders) {
      const orderNumber = String(o.orderNumber || o.order_number || '').trim();
      if (!orderNumber) continue;

      insertOrder.run(
        orderNumber,
        String(o.pharmacyName || o.pharmacy_name || ''),
        String(o.phone || ''),
        String(o.staffName || o.staff_name || ''),
        Number(o.totalAmount ?? o.total_amount) || 0,
        String(o.status || 'معتمد للتجهيز'),
        String(o.date || ''),
        String(o.createdAt || o.created_at || ''),
        String(o.deliveryStaffName || o.delivery_staff_name || ''),
        String(o.deliveredAt || o.delivered_at || ''),
        String(o.userId || o.user_id || ''),
        String(o.staffEmail || o.staff_email || '')
      );

      if (Array.isArray(o.items)) {
        for (const it of o.items) {
          const qty = Number(it.quantity) || 0;
          const pr = Number(it.price) || 0;
          insertDetail.run(
            orderNumber,
            String(it.id || ''),
            String(it.name || ''),
            String(it.barcode || ''),
            String(it.form || ''),
            qty,
            pr,
            qty * pr,
            String(it.expiryDate || it.expiry_date || '')
          );
        }
      }
    }
    console.log(`Seeded ${seedData.orders.length} historical orders`);
  }

  // 4. Seed Pharmacies (if present in backup)
  if (Array.isArray(seedData.pharmacies) && seedData.pharmacies.length > 0) {
    const insertPh = db.prepare(`
      INSERT OR REPLACE INTO pharmacies
      (id, name, phone, address, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const ph of seedData.pharmacies) {
      const phId = String(ph.id || `PH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
      const phName = String(ph.name || '').trim();
      if (!phName) continue;
      insertPh.run(
        phId,
        phName,
        String(ph.phone || '').trim(),
        String(ph.address || '').trim(),
        String(ph.notes || '').trim(),
        String(ph.createdAt || ph.created_at || new Date().toISOString())
      );
    }
    console.log(`Seeded ${seedData.pharmacies.length} pharmacies`);
  }

  // 5. Seed Stock Movements (if present in backup)
  if (Array.isArray(seedData.movements) && seedData.movements.length > 0) {
    const insertMv = db.prepare(`
      INSERT OR REPLACE INTO stock_movements
      (id, timestamp, product_id, product_name, type, quantity_before, quantity_change, quantity_after, reason, user, order_number, barcode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const m of seedData.movements) {
      insertMv.run(
        m.id ?? null,
        String(m.timestamp || new Date().toISOString()),
        String(m.productId || m.product_id || ''),
        String(m.productName || m.product_name || ''),
        String(m.type || ''),
        Number(m.before ?? m.quantity_before ?? 0),
        Number(m.change ?? m.quantity_change ?? 0),
        Number(m.after ?? m.quantity_after ?? 0),
        String(m.reason || ''),
        String(m.user || ''),
        String(m.orderNumber || m.order_number || ''),
        String(m.barcode || '')
      );
    }
    console.log(`Seeded ${seedData.movements.length} movements`);
  }

  try {
    db.prepare('INSERT OR REPLACE INTO app_meta (key, val) VALUES (?, ?)').run('initialized', '1');
  } catch {}

  // Backup snapshot to JSON file for redundancy
  exportJsonBackup(db);
}

export function exportJsonBackup(db: DatabaseSync = getDb()) {
  try {
    const products = getAllProducts(db);
    const orders = getAllOrders(db);
    const staff = getAllStaff(db);
    const movements = getAllMovements(db);
    const pharmacies = getAllPharmacies(db);

    const backup = {
      timestamp: new Date().toISOString(),
      productsCount: products.length,
      ordersCount: orders.length,
      staffCount: staff.length,
      movementsCount: movements.length,
      pharmaciesCount: pharmacies.length,
      products,
      orders,
      staffNames: staff,
      movements,
      pharmacies
    };

    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2), 'utf8');
    fs.writeFileSync(SEED_FILE, JSON.stringify(backup, null, 2), 'utf8');

    try {
      db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    } catch {}
  } catch (err) {
    console.warn('Backup export failed:', err);
  }
}

export function syncProductsFromSupabase(db: DatabaseSync, products: any[]) {
  if (!Array.isArray(products) || products.length === 0) return;

  const insertOrReplace = db.prepare(`
    INSERT OR REPLACE INTO products
    (id, name, barcode, company, quantity, min_qty, price, total_price, bonus, expiry_date, form, image, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const supabaseIds = new Set<string>();

  for (const p of products) {
    supabaseIds.add(p.id);
    const quantity = Math.max(0, Number(p.quantity) || 0);
    const price = Math.max(0, Number(p.price) || 0);
    const totalPrice = Number(p.totalPrice) || (quantity * price);
    insertOrReplace.run(
      p.id,
      p.name,
      p.barcode || '',
      p.company || '',
      quantity,
      Number(p.minQty) || 0,
      price,
      totalPrice,
      Number(p.bonus) || 0,
      p.expiryDate || '',
      p.form || '',
      p.image || '',
      p.createdAt || new Date().toISOString()
    );
  }

  // Remove stale products that no longer exist in Supabase samo table
  const allLocal = db.prepare('SELECT id FROM products').all() as any[];
  for (const loc of allLocal) {
    if (!supabaseIds.has(loc.id)) {
      db.prepare('DELETE FROM products WHERE id = ?').run(loc.id);
    }
  }

  exportJsonBackup(db);
}

export function formatBarcode(val: any): string {
  if (!val) return '';
  let str = String(val).trim();
  if (str.toLowerCase().includes('e')) {
    let num = Number(str);
    if (!isNaN(num)) {
      return BigInt(Math.round(num)).toString();
    }
  }
  return str.replace(/\.0+$/, '').replace(/\D/g, ''); // numbers only
}

export function getAllProducts(db: DatabaseSync = getDb()): any[] {
  const rows = db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE ASC').all() as any[];
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    barcode: formatBarcode(r.barcode),
    company: r.company || '',
    quantity: Number(r.quantity) || 0,
    minQty: Number(r.min_qty) || 5,
    price: Number(r.price) || 0,
    totalPrice: Number(r.total_price) || 0,
    bonus: Number(r.bonus) || 0,
    expiryDate: r.expiry_date || '',
    form: r.form || '',
    image: r.image || '',
    createdAt: r.created_at || ''
  }));
}

export function getAllOrders(db: DatabaseSync = getDb()): any[] {
  const orders = db.prepare('SELECT * FROM orders ORDER BY rowid DESC').all() as any[];
  const details = db.prepare('SELECT * FROM order_details ORDER BY id ASC').all() as any[];

  // Cache products for fast expiry resolution
  const prodRows = db.prepare('SELECT id, name, barcode, expiry_date FROM products').all() as any[];
  const prodById = new Map<string, string>();
  const prodByBarcode = new Map<string, string>();
  const prodByName = new Map<string, string>();
  for (const p of prodRows) {
    const exp = String(p.expiry_date || '').trim();
    if (exp) {
      if (p.id) prodById.set(p.id, exp);
      if (p.barcode) prodByBarcode.set(p.barcode, exp);
      if (p.name) prodByName.set(String(p.name).trim().toLowerCase(), exp);
    }
  }

  const detailsByOrder = new Map<string, any[]>();
  for (const d of details) {
    const list = detailsByOrder.get(d.order_number) || [];
    let exp = String(d.expiry_date || '').trim();
    if (!exp || exp === '-' || exp === 'غير مسجل') {
      if (d.product_id && prodById.has(d.product_id)) {
        exp = prodById.get(d.product_id)!;
      } else if (d.barcode && prodByBarcode.has(d.barcode)) {
        exp = prodByBarcode.get(d.barcode)!;
      } else if (d.product_name && prodByName.has(String(d.product_name).trim().toLowerCase())) {
        exp = prodByName.get(String(d.product_name).trim().toLowerCase())!;
      }
    }

    list.push({
      id: d.product_id || '',
      name: d.product_name,
      barcode: d.barcode || '',
      form: d.form || '',
      quantity: Number(d.quantity) || 0,
      price: Number(d.price) || 0,
      expiryDate: exp
    });
    detailsByOrder.set(d.order_number, list);
  }

  return orders.map(o => ({
    id: o.order_number,
    orderNumber: o.order_number,
    checkout_id: o.checkout_id || '',
    checkoutId: o.checkout_id || '',
    pharmacyName: o.pharmacy_name || '',
    phone: o.phone || '',
    staffName: o.staff_name || '',
    staffEmail: o.staff_email || '',
    totalAmount: Number(o.total_amount) || 0,
    status: o.status || 'قيد المراجعة',
    date: o.date || '',
    createdAt: o.created_at || '',
    deliveryStaffName: o.delivery_staff_name || '',
    deliveredAt: o.delivered_at || '',
    userId: o.user_id || '',
    items: detailsByOrder.get(o.order_number) || []
  }));
}

export function getAllStaff(db: DatabaseSync = getDb()): string[] {
  const rows = db.prepare('SELECT name FROM staff ORDER BY name ASC').all() as any[];
  return rows.map(r => r.name);
}

export function getAllStaffDetailed(db: DatabaseSync = getDb()): any[] {
  try {
    const rows = db.prepare('SELECT name, email, role, assigned_pharmacy as assignedPharmacy, assigned_pharmacy_phone as assignedPharmacyPhone, created_at as createdAt FROM staff ORDER BY name ASC').all() as any[];
    return rows.map(r => ({
      name: r.name,
      email: r.email || '',
      role: r.role || 'مندوب',
      assignedPharmacy: r.assignedPharmacy || '',
      assignedPharmacyPhone: r.assignedPharmacyPhone || '',
      createdAt: r.createdAt || ''
    }));
  } catch {
    const rows = db.prepare('SELECT name FROM staff ORDER BY name ASC').all() as any[];
    return rows.map(r => ({ name: r.name, email: '', role: 'مندوب', assignedPharmacy: '', assignedPharmacyPhone: '' }));
  }
}

export function getAllMovements(db: DatabaseSync = getDb(), limit: number = 2000): any[] {
  const rows = db.prepare('SELECT * FROM stock_movements ORDER BY id DESC LIMIT ?').all(limit) as any[];
  return rows.map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    productId: r.product_id,
    productName: r.product_name,
    type: r.type,
    before: r.quantity_before,
    change: r.quantity_change,
    after: r.quantity_after,
    reason: r.reason,
    user: r.user,
    orderNumber: r.order_number,
    barcode: r.barcode
  }));
}

// Transactional Stock & Order Operations

export function addOrder(db: DatabaseSync, order: any, forceDuplicate: boolean = false) {
  const orderNumber = String(order.orderNumber || order.id || '').trim();
  if (!orderNumber) throw new Error('رقم الطلب مطلوب');

  const checkoutId = (order.checkout_id || order.checkoutId) ? String(order.checkout_id || order.checkoutId).trim() : null;

  // Rule: ONE CHECKOUT = ONE ORDER (idempotency by checkout_id)
  if (checkoutId) {
    const existingByCheckout = db.prepare('SELECT * FROM orders WHERE checkout_id = ?').get(checkoutId) as any;
    if (existingByCheckout) {
      console.log(`[addOrder] Reusing existing order for checkout_id: ${checkoutId} (order_number: ${existingByCheckout.order_number})`);
      return { duplicateAlreadyExists: true, order: existingByCheckout };
    }
  }

  const existing = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber) as any;
  if (existing) {
    return { duplicateAlreadyExists: true, order: existing };
  }

  // Check for duplicate items recently sent
  if (!forceDuplicate && order.items && order.items.length > 0) {
    const recent = db.prepare(`
      SELECT * FROM orders 
      WHERE pharmacy_name = ? AND status = 'قيد المراجعة'
      ORDER BY rowid DESC LIMIT 5
    `).all(String(order.pharmacyName || '').trim()) as any[];

    for (const ro of recent) {
      const roItems = db.prepare('SELECT * FROM order_details WHERE order_number = ?').all(ro.order_number) as any[];
      if (roItems.length === order.items.length) {
        const matchAll = order.items.every((it: any) =>
          roItems.some((ri: any) => ri.product_name === it.name && ri.quantity === it.quantity)
        );
        if (matchAll) {
          return { duplicateWarning: true, duplicateOrderNumber: ro.order_number };
        }
      }
    }
  }

  db.prepare(`
    INSERT INTO orders 
    (order_number, checkout_id, pharmacy_name, phone, staff_name, total_amount, status, date, created_at, delivery_staff_name, delivered_at, user_id, staff_email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderNumber,
    checkoutId,
    String(order.pharmacyName || ''),
    String(order.phone || ''),
    String(order.staffName || ''),
    Number(order.totalAmount) || 0,
    String(order.status || 'قيد المراجعة'),
    String(order.date || new Date().toLocaleString('ar-IQ')),
    String(order.createdAt || new Date().toISOString()),
    String(order.deliveryStaffName || ''),
    String(order.deliveredAt || ''),
    String(order.userId || ''),
    String(order.staffEmail || order.staff_email || '')
  );

  const insertDetail = db.prepare(`
    INSERT INTO order_details
    (order_number, product_id, product_name, barcode, form, quantity, price, total, expiry_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  if (Array.isArray(order.items)) {
    for (const it of order.items) {
      const qty = Number(it.quantity) || 0;
      const pr = Number(it.price) || 0;
      let exp = String(it.expiryDate || it.expiry_date || '').trim();
      if (!exp || exp === '-' || exp === 'غير مسجل') {
        let pMatch: any = null;
        if (it.id) pMatch = db.prepare('SELECT expiry_date FROM products WHERE id = ?').get(it.id);
        if (!pMatch && it.barcode) pMatch = db.prepare('SELECT expiry_date FROM products WHERE barcode = ?').get(it.barcode);
        if (!pMatch && it.name) pMatch = db.prepare('SELECT expiry_date FROM products WHERE name = ?').get(it.name);
        if (pMatch && pMatch.expiry_date) exp = String(pMatch.expiry_date).trim();
      }
      insertDetail.run(
        orderNumber,
        String(it.id || ''),
        String(it.name || ''),
        String(it.barcode || ''),
        String(it.form || ''),
        qty,
        pr,
        qty * pr,
        exp
      );
    }
  }

  exportJsonBackup(db);
  return { success: true, order };
}

export function approveOrder(db: DatabaseSync, orderNumber: string, staffName: string, items: any[], totalAmount: number) {
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber) as any;
  if (order) {
    db.prepare("UPDATE orders SET status = 'تم التجهيز', staff_name = ? WHERE order_number = ?").run(staffName || 'صاحب المذخر', orderNumber);
  }

  const nowStr = new Date().toLocaleString('ar-IQ');

  // Deduct inventory for each item and record movement
  for (const it of items) {
    const qtyDeduct = Math.max(0, Math.floor(Number(it.quantity) || 0));
    if (qtyDeduct <= 0) continue;

    let prod: any = null;
    if (it.id) {
      prod = db.prepare('SELECT * FROM products WHERE id = ?').get(it.id);
    }
    if (!prod && it.barcode) {
      prod = db.prepare('SELECT * FROM products WHERE barcode = ?').get(it.barcode);
    }
    if (!prod && it.name) {
      prod = db.prepare('SELECT * FROM products WHERE name = ?').get(it.name);
    }

    if (prod) {
      const before = Number(prod.quantity) || 0;
      const after = Math.max(0, before - qtyDeduct);
      const newTotal = after * Number(prod.price || 0);

      db.prepare('UPDATE products SET quantity = ?, total_price = ? WHERE id = ?').run(after, newTotal, prod.id);

      db.prepare(`
        INSERT INTO stock_movements
        (timestamp, product_id, product_name, type, quantity_before, quantity_change, quantity_after, reason, user, order_number, barcode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nowStr,
        prod.id,
        prod.name,
        'صادر / تجهيز طلب',
        before,
        -qtyDeduct,
        after,
        `اعتماد وتجهيز طلبية رقم ${orderNumber}`,
        staffName || 'المذخر',
        orderNumber,
        prod.barcode || it.barcode || ''
      );
    }
  }

  // Update order status
  db.prepare(`
    UPDATE orders 
    SET status = 'معتمد للتجهيز', staff_name = ?, total_amount = ?
    WHERE order_number = ?
  `).run(staffName, totalAmount, orderNumber);

  // Refresh order details if items provided
  if (Array.isArray(items) && items.length > 0) {
    db.prepare('DELETE FROM order_details WHERE order_number = ?').run(orderNumber);
    const insertDetail = db.prepare(`
      INSERT INTO order_details
      (order_number, product_id, product_name, barcode, form, quantity, price, total, expiry_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const it of items) {
      const qty = Number(it.quantity) || 0;
      const pr = Number(it.price) || 0;
      let exp = String(it.expiryDate || it.expiry_date || '').trim();
      if (!exp || exp === '-' || exp === 'غير مسجل') {
        let pMatch: any = null;
        if (it.id) pMatch = db.prepare('SELECT expiry_date FROM products WHERE id = ?').get(it.id);
        if (!pMatch && it.barcode) pMatch = db.prepare('SELECT expiry_date FROM products WHERE barcode = ?').get(it.barcode);
        if (!pMatch && it.name) pMatch = db.prepare('SELECT expiry_date FROM products WHERE name = ?').get(it.name);
        if (pMatch && pMatch.expiry_date) exp = String(pMatch.expiry_date).trim();
      }
      insertDetail.run(
        orderNumber,
        String(it.id || ''),
        String(it.name || ''),
        String(it.barcode || ''),
        String(it.form || ''),
        qty,
        pr,
        qty * pr,
        exp
      );
    }
  }

  exportJsonBackup(db);
  return { success: true };
}

export function deliverOrder(db: DatabaseSync, orderNumber: string, deliveryStaffName: string, deliveredAt: string) {
  db.prepare(`
    UPDATE orders 
    SET status = 'مستلم', delivery_staff_name = ?, delivered_at = ?
    WHERE order_number = ?
  `).run(deliveryStaffName, deliveredAt || new Date().toLocaleString('ar-IQ'), orderNumber);

  exportJsonBackup(db);
  return { success: true };
}

export function discardPendingOrder(db: DatabaseSync, orderNumber: string) {
  const trimmed = String(orderNumber || '').trim();
  if (!trimmed) return { success: true };

  // Check if this order was already approved and deducted from stock
  const ord = db.prepare('SELECT * FROM orders WHERE TRIM(order_number) = ?').get(trimmed) as any;
  if (ord) {
    const st = String(ord.status || '').trim().toLowerCase();
    const isApproved = [
      'مستلم',
      'مسلّم',
      'مسلم',
      'مسلّمة',
      'مسلمة',
      'تم التسليم',
      'تم تسليمها',
      'مسلمة بنجاح',
      'delivered',
      'معتمد',
      'معتمد للتجهيز',
      'مجهزة',
      'تم التجهيز',
      'approved',
      'مكتمل'
    ].includes(st);
    if (isApproved) {
      // Restore inventory items
      const details = db.prepare('SELECT * FROM order_details WHERE TRIM(order_number) = ?').all(trimmed) as any[];
      const nowStr = new Date().toLocaleString('ar-IQ');
      for (const d of details) {
        const qtyToRestore = Math.max(0, Math.floor(Number(d.quantity) || 0));
        if (qtyToRestore <= 0) continue;
        let prod: any = null;
        if (d.product_id) prod = db.prepare('SELECT * FROM products WHERE id = ?').get(d.product_id);
        if (!prod && d.barcode) prod = db.prepare('SELECT * FROM products WHERE barcode = ?').get(d.barcode);
        if (!prod && d.product_name) prod = db.prepare('SELECT * FROM products WHERE name = ?').get(d.product_name);
        if (prod) {
          const before = Number(prod.quantity) || 0;
          const after = before + qtyToRestore;
          const newTotal = after * Number(prod.price || 0);
          db.prepare('UPDATE products SET quantity = ?, total_price = ? WHERE id = ?').run(after, newTotal, prod.id);
          db.prepare(`
            INSERT INTO stock_movements
            (timestamp, product_id, product_name, type, quantity_before, quantity_change, quantity_after, reason, user, order_number, barcode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            nowStr,
            prod.id,
            prod.name,
            'وارد / إلغاء طلب صادر',
            before,
            qtyToRestore,
            after,
            `إلغاء الطلبية المعتمدة رقم ${trimmed} واسترجاع المواد للمخزن`,
            'المذخر',
            trimmed,
            prod.barcode || d.barcode || ''
          );
        }
      }
    }
  }

  // Always delete details and order cleanly by trimmed order_number
  db.prepare('DELETE FROM order_details WHERE TRIM(order_number) = ?').run(trimmed);
  db.prepare('DELETE FROM orders WHERE TRIM(order_number) = ?').run(trimmed);

  exportJsonBackup(db);
  return { success: true };
}

export function mergePendingOrders(db: DatabaseSync, orderNumbers: string[]) {
  const cleaned = (orderNumbers || []).map(n => String(n || '').trim()).filter(Boolean);
  if (cleaned.length < 2) {
    throw new Error('يجب اختيار طلبيتين على الأقل للدمج');
  }

  // Fetch all orders with details
  const ordersList: any[] = [];
  for (const num of cleaned) {
    const ord = db.prepare('SELECT * FROM orders WHERE TRIM(order_number) = ?').get(num) as any;
    if (ord) {
      const items = db.prepare('SELECT * FROM order_details WHERE TRIM(order_number) = ?').all(num) as any[];
      ordersList.push({ ...ord, items });
    }
  }

  if (ordersList.length < 2) {
    throw new Error('لم يتم العثور على طلبيات كافية في قاعدة البيانات');
  }

  const targetOrder = ordersList[0];
  const otherOrders = ordersList.slice(1);

  // Combine items map: key by product id or name
  const itemsMap = new Map<string, any>();

  for (const o of ordersList) {
    for (const it of (o.items || [])) {
      const pName = String(it.product_name || '').trim();
      const pId = String(it.product_id || '').trim();
      const key = (pId || pName).toLowerCase();
      if (!key) continue;

      if (!itemsMap.has(key)) {
        itemsMap.set(key, {
          productId: pId,
          productName: pName || 'مادة بدون اسم',
          barcode: String(it.barcode || '').trim(),
          form: String(it.form || 'Tablet').trim(),
          quantity: Math.max(0, Math.floor(Number(it.quantity) || 0)),
          price: Math.max(0, Number(it.price) || 0),
          expiryDate: String(it.expiry_date || '').trim()
        });
      } else {
        const exist = itemsMap.get(key);
        exist.quantity += Math.max(0, Math.floor(Number(it.quantity) || 0));
        if (Number(it.price) > exist.price) exist.price = Number(it.price);
        if (!exist.barcode && it.barcode) exist.barcode = String(it.barcode).trim();
        if (!exist.expiryDate && it.expiry_date) exist.expiryDate = String(it.expiry_date).trim();
      }
    }
  }

  const mergedItems = Array.from(itemsMap.values());
  const totalAmount = mergedItems.reduce((sum, it) => sum + (it.quantity * it.price), 0);

  // Target pharmacy name & metadata
  const phName = targetOrder.pharmacy_name || otherOrders.find(x => x.pharmacy_name)?.pharmacy_name || 'صيدلية غير مسجلة';
  const phone = targetOrder.phone || otherOrders.find(x => x.phone)?.phone || '';
  const staff = targetOrder.staff_name || otherOrders.find(x => x.staff_name)?.staff_name || '';
  const userId = targetOrder.user_id || otherOrders.find(x => x.user_id)?.user_id || '';

  // Update target order in DB
  db.prepare(`
    UPDATE orders 
    SET pharmacy_name = ?, phone = ?, total_amount = ?, staff_name = ?, user_id = ?
    WHERE TRIM(order_number) = ?
  `).run(phName, phone, totalAmount, staff, userId, targetOrder.order_number);

  // Re-insert order_details for target order
  db.prepare('DELETE FROM order_details WHERE TRIM(order_number) = ?').run(targetOrder.order_number);
  const insertDetail = db.prepare(`
    INSERT INTO order_details
    (order_number, product_id, product_name, barcode, form, quantity, price, total, expiry_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const it of mergedItems) {
    const q = Number(it.quantity) || 0;
    const p = Number(it.price) || 0;
    insertDetail.run(
      targetOrder.order_number,
      it.productId,
      it.productName,
      it.barcode,
      it.form,
      q,
      p,
      q * p,
      it.expiryDate
    );
  }

  // Delete other merged orders
  for (const other of otherOrders) {
    db.prepare('DELETE FROM order_details WHERE TRIM(order_number) = ?').run(other.order_number);
    db.prepare('DELETE FROM orders WHERE TRIM(order_number) = ?').run(other.order_number);
  }

  exportJsonBackup(db);

  return {
    success: true,
    targetOrderNumber: targetOrder.order_number,
    pharmacyName: phName,
    mergedOrdersCount: ordersList.length,
    deletedOrderNumbers: otherOrders.map(o => o.order_number),
    items: mergedItems.map(it => ({
      id: it.productId,
      name: it.productName,
      barcode: it.barcode,
      form: it.form,
      quantity: it.quantity,
      price: it.price,
      expiryDate: it.expiryDate
    })),
    totalAmount
  };
}

export function returnOrderItem(db: DatabaseSync, orderNumber: string, item: { name: string; barcode?: string; quantity: number }) {
  const qty = Number(item.quantity) || 0;
  if (qty <= 0) throw new Error('الكمية المرجعة يجب أن تكون أكبر من صفر');

  const nowStr = new Date().toLocaleString('ar-IQ');

  let prod: any = null;
  if (item.barcode) {
    prod = db.prepare('SELECT * FROM products WHERE barcode = ?').get(item.barcode);
  }
  if (!prod && item.name) {
    prod = db.prepare('SELECT * FROM products WHERE name = ?').get(item.name);
  }

  if (prod) {
    const before = Number(prod.quantity) || 0;
    const after = before + qty;
    const newTotal = after * Number(prod.price || 0);

    db.prepare('UPDATE products SET quantity = ?, total_price = ? WHERE id = ?').run(after, newTotal, prod.id);

    db.prepare(`
      INSERT INTO stock_movements
      (timestamp, product_id, product_name, type, quantity_before, quantity_change, quantity_after, reason, user, order_number, barcode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nowStr,
      prod.id,
      prod.name,
      'إرجاع مخزون',
      before,
      qty,
      after,
      `إرجاع مادة من الطلبية رقم ${orderNumber}`,
      'المذخر',
      orderNumber,
      prod.barcode || item.barcode || ''
    );
  }

  // Update order detail row
  const detail = db.prepare(`
    SELECT * FROM order_details 
    WHERE order_number = ? AND (product_name = ? OR barcode = ?)
  `).get(orderNumber, item.name, item.barcode || '') as any;

  if (detail) {
    const remainingQty = Math.max(0, Number(detail.quantity) - qty);
    db.prepare(`
      UPDATE order_details 
      SET quantity = ?, total = ?
      WHERE id = ?
    `).run(remainingQty, remainingQty * Number(detail.price), detail.id);
  }

  // Recalculate order total amount
  const newTotalRow = db.prepare('SELECT sum(total) as sumTotal FROM order_details WHERE order_number = ?').get(orderNumber) as any;
  const newTotal = Number(newTotalRow?.sumTotal) || 0;
  db.prepare('UPDATE orders SET total_amount = ? WHERE order_number = ?').run(newTotal, orderNumber);

  exportJsonBackup(db);
  return { success: true };
}

export function updateOrder(db: DatabaseSync, order: any) {
  const orderNumber = String(order.orderNumber || '').trim();
  if (!orderNumber) throw new Error('رقم الطلب مطلوب');

  const existing = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber) as any;
  if (!existing) throw new Error('الطلب غير موجود');

  const pharmacyName = order.pharmacyName !== undefined ? String(order.pharmacyName).trim() : existing.pharmacy_name;
  const phone = order.phone !== undefined ? String(order.phone).trim() : existing.phone;
  const date = order.date ? String(order.date).trim() : existing.date;
  const staffName = order.staffName ? String(order.staffName).trim() : existing.staff_name;
  const status = order.status ? String(order.status).trim() : existing.status;

  let calculatedTotal = 0;
  if (Array.isArray(order.items)) {
    calculatedTotal = order.items.reduce((sum: number, it: any) => {
      const q = Number(it.quantity) || 0;
      const p = Number(it.price) || 0;
      return sum + (q * p);
    }, 0);
  }
  const totalAmount = order.totalAmount !== undefined && order.totalAmount !== null
    ? Number(order.totalAmount)
    : calculatedTotal;

  db.prepare(`
    UPDATE orders 
    SET pharmacy_name = ?, phone = ?, total_amount = ?, date = ?, staff_name = ?, status = ?
    WHERE order_number = ?
  `).run(
    pharmacyName,
    phone,
    totalAmount,
    date,
    staffName,
    status,
    orderNumber
  );

  if (Array.isArray(order.items)) {
    db.prepare('DELETE FROM order_details WHERE order_number = ?').run(orderNumber);
    const insertDetail = db.prepare(`
      INSERT INTO order_details
      (order_number, product_id, product_name, barcode, form, quantity, price, total, expiry_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const it of order.items) {
      const qty = Number(it.quantity) || 0;
      const pr = Number(it.price) || 0;
      insertDetail.run(
        orderNumber,
        String(it.id || ''),
        String(it.name || ''),
        String(it.barcode || ''),
        String(it.form || ''),
        qty,
        pr,
        qty * pr,
        String(it.expiryDate || '')
      );
    }
  }

  exportJsonBackup(db);
  return { success: true, orderNumber, totalAmount };
}

export function addProduct(db: DatabaseSync, product: any) {
  const name = String(product.name || '').trim();
  if (!name) throw new Error('اسم المادة مطلوب');

  const barcode = formatBarcode(product.barcode);
  const id = String(product.id || `PROD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const company = String(product.company || '').trim();
  const quantity = Math.max(0, Number(product.quantity) || 0);
  const minQty = Math.max(0, Number(product.minQty) || 5);
  const price = Math.max(0, Number(product.price) || 0);
  const totalPrice = quantity * price;
  const bonus = Math.max(0, Number(product.bonus) || 0);
  const expiryDate = String(product.expiryDate || '').trim();
  const form = String(product.form || 'Tablet').trim();
  const image = String(product.image || '').trim();
  const createdAt = product.createdAt || new Date().toISOString();

  // If existing product matches by ID or barcode, update it
  let existing: any = null;
  if (barcode) {
    existing = db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);
  }
  if (!existing) {
    existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  }

  const targetId = existing ? existing.id : id;

  db.prepare(`
    INSERT OR REPLACE INTO products
    (id, name, barcode, company, quantity, min_qty, price, total_price, bonus, expiry_date, form, image, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(targetId, name, barcode, company, quantity, minQty, price, totalPrice, bonus, expiryDate, form, image, createdAt);

  if (quantity > 0) {
    try {
      db.prepare(`
        INSERT INTO stock_movements
        (timestamp, product_id, product_name, type, quantity_before, quantity_change, quantity_after, reason, user, order_number, barcode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        new Date().toLocaleString('ar-IQ'),
        targetId,
        name,
        existing ? 'تحديث مادة' : 'إضافة مادة جديدة',
        existing ? Number(existing.quantity || 0) : 0,
        quantity,
        quantity,
        'إضافة مادة دوائية للمخزن',
        'المذخر',
        '',
        barcode
      );
    } catch (e) {
      console.warn('Stock movement insertion warning:', e);
    }
  }

  exportJsonBackup(db);
  return { success: true, product: { id: targetId, name, barcode, company, quantity, minQty, price, totalPrice, bonus, expiryDate, form, image, createdAt } };
}

export function updateProduct(db: DatabaseSync, product: any, stockOperation?: { mode: string; amount: number; reason: string }) {
  const id = String(product.id || '').trim();
  const name = String(product.name || '').trim();
  const barcode = formatBarcode(product.barcode);

  let oldProd: any = null;
  if (id) {
    oldProd = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  }
  if (!oldProd && barcode) {
    oldProd = db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);
  }
  if (!oldProd && name) {
    oldProd = db.prepare('SELECT * FROM products WHERE name = ?').get(name);
  }

  const targetId = oldProd ? oldProd.id : (id || `PROD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const targetName = name || (oldProd ? oldProd.name : 'مادة دوائية');
  const newQty = Math.max(0, Math.floor(Number(product.quantity) || 0));
  const oldQty = oldProd ? Number(oldProd.quantity || 0) : 0;
  const price = Math.max(0, Number(product.price) || 0);
  const totalPrice = newQty * price;

  db.prepare(`
    INSERT OR REPLACE INTO products 
    (id, name, barcode, company, quantity, min_qty, price, total_price, bonus, expiry_date, form, image, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    targetId,
    targetName,
    barcode || (oldProd ? oldProd.barcode : ''),
    String(product.company || (oldProd ? oldProd.company : '')).trim(),
    newQty,
    Number(product.minQty) || 5,
    price,
    totalPrice,
    Number(product.bonus) || 0,
    String(product.expiryDate || (oldProd ? oldProd.expiry_date : '')),
    String(product.form || (oldProd ? oldProd.form : 'Tablet')),
    String(product.image || (oldProd ? oldProd.image : '')),
    oldProd ? oldProd.created_at : new Date().toISOString()
  );

  if (newQty !== oldQty) {
    try {
      db.prepare(`
        INSERT INTO stock_movements
        (timestamp, product_id, product_name, type, quantity_before, quantity_change, quantity_after, reason, user, order_number, barcode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        new Date().toLocaleString('ar-IQ'),
        targetId,
        targetName,
        'تعديل رصيد',
        oldQty,
        newQty - oldQty,
        newQty,
        stockOperation?.reason || 'تعديل يدوي صريح لرصيد المخزون',
        'المذخر',
        '',
        barcode || (oldProd ? oldProd.barcode : '')
      );
    } catch (e) {
      console.warn('Stock movement insertion warning on update:', e);
    }
  }

  exportJsonBackup(db);
  return { success: true };
}

export function deleteProduct(db: DatabaseSync, productId: string, barcode?: string, name?: string) {
  const pId = String(productId || '').trim();
  const bCode = String(barcode || '').trim();
  const pName = String(name || '').trim();

  let prod: any = null;
  if (pId) {
    prod = db.prepare('SELECT * FROM products WHERE id = ?').get(pId);
  }
  if (!prod && bCode) {
    prod = db.prepare('SELECT * FROM products WHERE barcode = ?').get(bCode);
  }
  if (!prod && pName) {
    prod = db.prepare('SELECT * FROM products WHERE name = ?').get(pName);
  }

  if (prod) {
    if (Number(prod.quantity) > 0) {
      try {
        db.prepare(`
          INSERT INTO stock_movements
          (timestamp, product_id, product_name, type, quantity_before, quantity_change, quantity_after, reason, user, order_number, barcode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          new Date().toLocaleString('ar-IQ'),
          prod.id,
          prod.name,
          'حذف مادة',
          Number(prod.quantity),
          -Number(prod.quantity),
          0,
          'حذف المادة من المخزن',
          'المذخر',
          '',
          prod.barcode || ''
        );
      } catch (e) {
        console.warn('Movement record failed on delete:', e);
      }
    }
    db.prepare('DELETE FROM products WHERE id = ?').run(prod.id);
  }
  if (pId) {
    db.prepare('DELETE FROM products WHERE id = ?').run(pId);
  }
  if (pName) {
    db.prepare('DELETE FROM products WHERE name = ?').run(pName);
  }

  exportJsonBackup(db);
  return { success: true };
}

export function addStaff(db: DatabaseSync, name: string, assignedPharmacy = '', pharmacyPhone = '', email = '', role = 'مندوب') {
  const trimmed = String(name || '').trim();
  const trimmedEmail = String(email || '').trim().toLowerCase();
  if (!trimmed && !trimmedEmail) throw new Error('اسم الموظف أو البريد مطلوب');

  let existing: any = null;
  if (trimmedEmail) {
    existing = db.prepare('SELECT * FROM staff WHERE LOWER(email) = ?').get(trimmedEmail);
  }
  if (!existing && trimmed) {
    existing = db.prepare('SELECT * FROM staff WHERE LOWER(name) = ?').get(trimmed.toLowerCase());
  }

  if (existing) {
    const finalEmail = trimmedEmail || existing.email || '';
    const finalName = trimmed || existing.name;
    const finalRole = role || existing.role || 'مندوب';
    const finalPh = assignedPharmacy || existing.assigned_pharmacy || '';
    const finalPhone = pharmacyPhone || existing.assigned_pharmacy_phone || '';

    db.prepare('UPDATE staff SET name = ?, email = ?, role = ?, assigned_pharmacy = ?, assigned_pharmacy_phone = ? WHERE name = ? OR (email != "" AND LOWER(email) = ?)')
      .run(finalName, finalEmail, finalRole, finalPh, finalPhone, existing.name, finalEmail);

    if (finalEmail) {
      db.prepare('DELETE FROM staff WHERE LOWER(email) = ? AND name != ?').run(finalEmail, finalName);
    }
    exportJsonBackup(db);
    return { success: true, name: finalName, assignedPharmacy: finalPh, role: finalRole, email: finalEmail };
  } else {
    const newName = trimmed || trimmedEmail.split('@')[0];
    db.prepare('INSERT OR IGNORE INTO staff (name, email, role, assigned_pharmacy, assigned_pharmacy_phone, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newName, trimmedEmail, role || 'مندوب', assignedPharmacy || '', pharmacyPhone || '', new Date().toISOString());

    if (trimmedEmail) {
      db.prepare('DELETE FROM staff WHERE LOWER(email) = ? AND name != ?').run(trimmedEmail, newName);
    }
    exportJsonBackup(db);
    return { success: true, name: newName, assignedPharmacy, role, email: trimmedEmail };
  }
}

export function upsertStaffUser(db: DatabaseSync, data: { name?: string; email: string; role?: string; assignedPharmacy?: string; pharmacyPhone?: string }) {
  const trimmedEmail = String(data.email || '').trim().toLowerCase();
  const trimmedName = String(data.name || (trimmedEmail ? trimmedEmail.split('@')[0] : 'موظف')).trim();
  const role = data.role || 'مندوب';
  const assignedPh = data.assignedPharmacy || '';
  const phPhone = data.pharmacyPhone || '';

  if (!trimmedEmail && !trimmedName) throw new Error('الاسم أو البريد مطلوب');

  let existing: any = null;
  if (trimmedEmail) {
    existing = db.prepare('SELECT * FROM staff WHERE LOWER(email) = ?').get(trimmedEmail);
  }
  if (!existing && trimmedName) {
    existing = db.prepare('SELECT * FROM staff WHERE LOWER(name) = ?').get(trimmedName.toLowerCase());
  }

  if (existing) {
    const updatedEmail = trimmedEmail || existing.email || '';
    const updatedName = (trimmedName && trimmedName !== 'موظف' && !trimmedName.includes('@')) ? trimmedName : existing.name;
    const updatedRole = data.role || existing.role || 'مندوب';
    const updatedPh = data.assignedPharmacy !== undefined ? assignedPh : (existing.assigned_pharmacy || '');
    const updatedPhone = data.pharmacyPhone !== undefined ? phPhone : (existing.assigned_pharmacy_phone || '');

    db.prepare('UPDATE staff SET name = ?, email = ?, role = ?, assigned_pharmacy = ?, assigned_pharmacy_phone = ? WHERE name = ? OR (email != "" AND LOWER(email) = ?)')
      .run(updatedName, updatedEmail, updatedRole, updatedPh, updatedPhone, existing.name, updatedEmail);

    if (updatedEmail) {
      db.prepare('DELETE FROM staff WHERE LOWER(email) = ? AND name != ?').run(updatedEmail, updatedName);
    }

    exportJsonBackup(db);
    return {
      success: true,
      name: updatedName,
      email: updatedEmail,
      role: updatedRole,
      assignedPharmacy: updatedPh,
      pharmacyPhone: updatedPhone,
      isOwner: (updatedRole === 'admin' || updatedRole === 'صاحب مذخر')
    };
  } else {
    db.prepare('INSERT OR IGNORE INTO staff (name, email, role, assigned_pharmacy, assigned_pharmacy_phone, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(trimmedName, trimmedEmail, role, assignedPh, phPhone, new Date().toISOString());

    if (trimmedEmail) {
      db.prepare('DELETE FROM staff WHERE LOWER(email) = ? AND name != ?').run(trimmedEmail, trimmedName);
    }

    exportJsonBackup(db);
    return {
      success: true,
      name: trimmedName,
      email: trimmedEmail,
      role,
      assignedPharmacy: assignedPh,
      pharmacyPhone: phPhone,
      isOwner: (role === 'admin' || role === 'صاحب مذخر')
    };
  }
}

export function updateStaffRole(db: DatabaseSync, nameOrEmail: string, role: string) {
  const target = String(nameOrEmail || '').trim().toLowerCase();
  const cleanRole = String(role || 'مندوب').trim();
  db.prepare('UPDATE staff SET role = ? WHERE LOWER(name) = ? OR LOWER(email) = ?').run(cleanRole, target, target);
  exportJsonBackup(db);
  return { success: true, target, role: cleanRole };
}

export function updateStaffAssignedPharmacy(db: DatabaseSync, name: string, assignedPharmacy: string, pharmacyPhone = '') {
  const trimmed = String(name || '').trim().toLowerCase();
  if (!trimmed) throw new Error('اسم الموظف أو البريد مطلوب');
  db.prepare('UPDATE staff SET assigned_pharmacy = ?, assigned_pharmacy_phone = ? WHERE LOWER(name) = ? OR LOWER(email) = ?').run(assignedPharmacy || '', pharmacyPhone || '', trimmed, trimmed);
  exportJsonBackup(db);
  return { success: true, name: trimmed, assignedPharmacy, pharmacyPhone };
}

export function deleteStaff(db: DatabaseSync, name: string) {
  const trimmed = String(name || '').trim().toLowerCase();
  db.prepare('DELETE FROM staff WHERE LOWER(name) = ? OR LOWER(email) = ?').run(trimmed, trimmed);
  exportJsonBackup(db);
  return { success: true };
}

export function getAllPharmacies(db: DatabaseSync = getDb()): any[] {
  const rows = db.prepare('SELECT * FROM pharmacies ORDER BY name COLLATE NOCASE ASC').all() as any[];
  const orderCounts = db.prepare('SELECT pharmacy_name, count(*) as count FROM orders GROUP BY pharmacy_name').all() as any[];
  const countMap = new Map<string, number>();
  orderCounts.forEach(r => {
    if (r.pharmacy_name) countMap.set(String(r.pharmacy_name).trim().toLowerCase(), Number(r.count) || 0);
  });

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    phone: r.phone || '',
    address: r.address || '',
    notes: r.notes || '',
    createdAt: r.created_at || '',
    ordersCount: countMap.get(String(r.name).trim().toLowerCase()) || 0
  }));
}

export function addPharmacy(db: DatabaseSync, data: any) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('اسم الصيدلية مطلوب');

  const phone = String(data.phone || '').trim();
  const address = String(data.address || '').trim();
  const notes = String(data.notes || '').trim();
  const id = String(data.id || `PH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const createdAt = data.createdAt || new Date().toISOString();

  // Check if pharmacy with same name exists
  const existing = db.prepare('SELECT * FROM pharmacies WHERE name = ? COLLATE NOCASE').get(name) as any;
  if (existing) {
    db.prepare(`
      UPDATE pharmacies 
      SET phone = ?, address = ?, notes = ?
      WHERE id = ?
    `).run(phone || existing.phone, address || existing.address, notes || existing.notes, existing.id);
    exportJsonBackup(db);
    return { success: true, pharmacy: { id: existing.id, name: existing.name, phone: phone || existing.phone, address: address || existing.address, notes: notes || existing.notes, createdAt: existing.created_at } };
  }

  db.prepare(`
    INSERT INTO pharmacies (id, name, phone, address, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, phone, address, notes, createdAt);

  exportJsonBackup(db);
  return { success: true, pharmacy: { id, name, phone, address, notes, createdAt } };
}

export function updatePharmacy(db: DatabaseSync, data: any) {
  const id = String(data.id || '').trim();
  const name = String(data.name || '').trim();
  if (!id && !name) throw new Error('معرف أو اسم الصيدلية مطلوب');

  let existing: any = null;
  if (id) {
    existing = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(id);
  }
  if (!existing && name) {
    existing = db.prepare('SELECT * FROM pharmacies WHERE name = ? COLLATE NOCASE').get(name);
  }

  if (!existing) throw new Error('الصيدلية غير موجودة');

  const targetName = name || existing.name;
  const phone = data.phone !== undefined ? String(data.phone).trim() : (existing.phone || '');
  const address = data.address !== undefined ? String(data.address).trim() : (existing.address || '');
  const notes = data.notes !== undefined ? String(data.notes).trim() : (existing.notes || '');

  db.prepare(`
    UPDATE pharmacies 
    SET name = ?, phone = ?, address = ?, notes = ?
    WHERE id = ?
  `).run(targetName, phone, address, notes, existing.id);

  exportJsonBackup(db);
  return { success: true, pharmacy: { id: existing.id, name: targetName, phone, address, notes } };
}

export function deletePharmacy(db: DatabaseSync, id: string, name?: string) {
  const pId = String(id || '').trim();
  const pName = String(name || '').trim();

  if (pId) {
    db.prepare('DELETE FROM pharmacies WHERE id = ?').run(pId);
  }
  if (pName) {
    db.prepare('DELETE FROM pharmacies WHERE name = ? COLLATE NOCASE').run(pName);
  }

  exportJsonBackup(db);
  return { success: true };
}

export function importPharmaciesFromOrders(db: DatabaseSync) {
  const distinctOrders = db.prepare("SELECT DISTINCT pharmacy_name, phone FROM orders WHERE TRIM(pharmacy_name) != ''").all() as any[];
  const insertPh = db.prepare('INSERT OR IGNORE INTO pharmacies (id, name, phone, address, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const nowIso = new Date().toISOString();
  let count = 0;

  for (const row of distinctOrders) {
    const phName = String(row.pharmacy_name || '').trim();
    if (phName) {
      const phId = `PH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const res = insertPh.run(phId, phName, String(row.phone || '').trim(), '', '', nowIso);
      if (res.changes > 0) count++;
    }
  }

  exportJsonBackup(db);
  return { success: true, importedCount: count, totalPharmacies: getAllPharmacies(db).length };
}

export function getSystemSettings(db: DatabaseSync = getDb()): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM system_settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {
    store_name: 'مذخر سامو الدوائي',
    store_phone: '07700000000',
    store_address: 'العراق - بغداد',
    invoice_note: 'شكراً لتعاملكم مع مذخر سامو الدوائي. يرجى تدقيق ومطابقة المواد والكميات عند الاستلام.',
    min_stock_alert: '5',
    near_expiry_months: '6',
    allow_overselling: 'false',
    default_hide_out_of_stock: 'false',
    currency_symbol: 'د.ع',
    enable_bonus: 'true',
    thermal_font_size: 'normal',
    print_qr: 'true',
    app_theme_color: '#007aff',
    prod_card_density: 'detailed',
    admin_pin: '1234'
  };
  rows.forEach(r => {
    if (r.key) settings[r.key] = r.value;
  });
  return settings;
}

export function saveSystemSettings(db: DatabaseSync, newSettings: Record<string, string>) {
  const stmt = db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(newSettings)) {
    if (k && v !== undefined) {
      stmt.run(k, String(v));
    }
  }
  exportJsonBackup(db);
  return { success: true, settings: getSystemSettings(db) };
}

export function saveStaffDraft(db: DatabaseSync, staffEmail: string, draftData: any) {
  if (!staffEmail) return { success: false, error: 'Staff email required' };
  const str = typeof draftData === 'string' ? draftData : JSON.stringify(draftData);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO staff_drafts (staff_email, draft_data, updated_at)
    VALUES (?, ?, ?)
  `).run(staffEmail.trim(), str, now);
  return { success: true, staffEmail, updatedAt: now };
}

export function getStaffDraft(db: DatabaseSync, staffEmail: string) {
  if (!staffEmail) return null;
  const row = db.prepare('SELECT * FROM staff_drafts WHERE staff_email = ?').get(staffEmail.trim()) as any;
  if (!row) return null;
  try {
    return {
      staffEmail: row.staff_email,
      draftData: JSON.parse(row.draft_data),
      updatedAt: row.updated_at
    };
  } catch {
    return {
      staffEmail: row.staff_email,
      draftData: row.draft_data,
      updatedAt: row.updated_at
    };
  }
}

export function deleteStaffDraft(db: DatabaseSync, staffEmail: string) {
  if (!staffEmail) return;
  db.prepare('DELETE FROM staff_drafts WHERE staff_email = ?').run(staffEmail.trim());
  return { success: true };
}

export function addInventoryLog(db: DatabaseSync, log: {
  product_id?: string;
  product_name: string;
  action_type: string;
  qty_before?: number;
  qty_change?: number;
  qty_after?: number;
  price_before?: number;
  price_after?: number;
  staff_email?: string;
  notes?: string;
}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO inventory_logs 
    (product_id, product_name, action_type, qty_before, qty_change, qty_after, price_before, price_after, staff_email, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.product_id || '',
    log.product_name || '',
    log.action_type || 'تعديل',
    Number(log.qty_before) || 0,
    Number(log.qty_change) || 0,
    Number(log.qty_after) || 0,
    Number(log.price_before) || 0,
    Number(log.price_after) || 0,
    log.staff_email || '',
    log.notes || '',
    now
  );
}

export function getInventoryLogs(db: DatabaseSync, limit = 200): any[] {
  try {
    return db.prepare('SELECT * FROM inventory_logs ORDER BY id DESC LIMIT ?').all(limit) as any[];
  } catch {
    return [];
  }
}

export function saveDbReport(db: DatabaseSync, reportData: {
  report_date: string;
  total_sales: number;
  orders_count?: number;
  pharmacies_count?: number;
  items_count?: number;
  generated_by_email?: string;
  generated_by?: string;
  summary_json?: any;
  summary?: any;
  created_at?: string;
}) {
  const now = reportData.created_at || new Date().toISOString();
  let summaryStr = '{}';
  if (typeof reportData.summary_json === 'object' && reportData.summary_json !== null) {
    summaryStr = JSON.stringify(reportData.summary_json);
  } else if (typeof reportData.summary === 'string' && reportData.summary) {
    summaryStr = reportData.summary;
  } else if (reportData.summary_json) {
    summaryStr = String(reportData.summary_json);
  }
  const author = reportData.generated_by_email || reportData.generated_by || '';
  db.prepare(`
    INSERT INTO reports 
    (report_date, total_sales, orders_count, pharmacies_count, items_count, generated_by_email, summary_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reportData.report_date,
    Number(reportData.total_sales) || 0,
    Number(reportData.orders_count) || 0,
    Number(reportData.pharmacies_count) || 0,
    Number(reportData.items_count) || 0,
    author,
    summaryStr,
    now
  );
  return { success: true };
}

export function getDbReports(db: DatabaseSync, limit = 50): any[] {
  try {
    return db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT ?').all(limit) as any[];
  } catch {
    return [];
  }
}


