import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

const DATA_CANDIDATES = [
  process.env.SAMO_DATA_DIR,
  path.join(process.cwd(), 'data'),
  typeof __dirname !== 'undefined' ? path.join(__dirname, 'data') : '',
  typeof __dirname !== 'undefined' ? path.join(__dirname, '..', 'data') : ''
].filter(Boolean) as string[];

const DATA_DIR = DATA_CANDIDATES.find(dir => fs.existsSync(dir)) || DATA_CANDIDATES[0] || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'samo_warehouse.db');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const BACKUP_FILE = path.join(DATA_DIR, 'backup_store.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;

  ensureDataDir();
  dbInstance = new DatabaseSync(DB_FILE);

  // Enable WAL mode for high performance and durability
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec('PRAGMA foreign_keys = ON;');

  initSchema(dbInstance);
  seedIfEmpty(dbInstance);

  return dbInstance;
}

function initSchema(db: DatabaseSync) {
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
      created_at TEXT DEFAULT ''
    );
  `);

  // 3. Orders table
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      order_number TEXT PRIMARY KEY,
      pharmacy_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      staff_name TEXT DEFAULT '',
      total_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'قيد المراجعة',
      date TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      delivery_staff_name TEXT DEFAULT '',
      delivered_at TEXT DEFAULT '',
      user_id TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_pharmacy ON orders(pharmacy_name);
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
}

function seedIfEmpty(db: DatabaseSync) {
  const countRow = db.prepare('SELECT count(*) as count FROM products').get() as { count: number };
  if (countRow && countRow.count > 0) {
    return; // Already seeded
  }

  console.log('Seeding database from initial seed file...');
  let seedData: any = null;

  if (fs.existsSync(SEED_FILE)) {
    try {
      seedData = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    } catch (err) {
      console.error('Failed to read seed file:', err);
    }
  }

  if (!seedData) {
    console.warn('No seed file found, starting with empty tables');
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
      const minQty = Number(p.minQty) || 5;
      const price = Number(p.price) || 0;
      const totalPrice = Number(p.totalPrice) || (quantity * price);
      const bonus = Number(p.bonus) || 0;
      const expiryDate = String(p.expiryDate || '');
      const form = String(p.form || '');
      const image = String(p.image || '');
      const createdAt = String(p.createdAt || '');

      insertProd.run(id, name, barcode, company, quantity, minQty, price, totalPrice, bonus, expiryDate, form, image, createdAt);

      // Record opening stock if quantity > 0
      if (quantity > 0) {
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
      (order_number, pharmacy_name, phone, staff_name, total_amount, status, date, created_at, delivery_staff_name, delivered_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertDetail = db.prepare(`
      INSERT INTO order_details
      (order_number, product_id, product_name, barcode, form, quantity, price, total, expiry_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const o of seedData.orders) {
      const orderNumber = String(o.orderNumber || '').trim();
      if (!orderNumber) continue;

      insertOrder.run(
        orderNumber,
        String(o.pharmacyName || ''),
        String(o.phone || ''),
        String(o.staffName || ''),
        Number(o.totalAmount) || 0,
        String(o.status || 'معتمد للتجهيز'),
        String(o.date || ''),
        String(o.createdAt || ''),
        String(o.deliveryStaffName || ''),
        String(o.deliveredAt || ''),
        String(o.userId || '')
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
            String(it.expiryDate || '')
          );
        }
      }
    }
    console.log(`Seeded ${seedData.orders.length} historical orders`);
  }

  // Backup snapshot to JSON file for redundancy
  exportJsonBackup(db);
}

export function exportJsonBackup(db: DatabaseSync = getDb()) {
  try {
    const products = getAllProducts(db);
    const orders = getAllOrders(db);
    const staff = getAllStaff(db);
    const movements = getAllMovements(db);

    const backup = {
      timestamp: new Date().toISOString(),
      productsCount: products.length,
      ordersCount: orders.length,
      staffCount: staff.length,
      movementsCount: movements.length,
      products,
      orders,
      staffNames: staff,
      movements
    };

    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2), 'utf8');
  } catch (err) {
    console.warn('Backup export failed:', err);
  }
}

export function getAllProducts(db: DatabaseSync = getDb()): any[] {
  const rows = db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE ASC').all() as any[];
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    barcode: r.barcode || '',
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

  const detailsByOrder = new Map<string, any[]>();
  for (const d of details) {
    const list = detailsByOrder.get(d.order_number) || [];
    list.push({
      id: d.product_id || '',
      name: d.product_name,
      barcode: d.barcode || '',
      form: d.form || '',
      quantity: Number(d.quantity) || 0,
      price: Number(d.price) || 0,
      expiryDate: d.expiry_date || ''
    });
    detailsByOrder.set(d.order_number, list);
  }

  return orders.map(o => ({
    orderNumber: o.order_number,
    pharmacyName: o.pharmacy_name || '',
    phone: o.phone || '',
    staffName: o.staff_name || '',
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
  const orderNumber = String(order.orderNumber || '').trim();
  if (!orderNumber) throw new Error('رقم الطلب مطلوب');

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
    (order_number, pharmacy_name, phone, staff_name, total_amount, status, date, created_at, delivery_staff_name, delivered_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderNumber,
    String(order.pharmacyName || ''),
    String(order.phone || ''),
    String(order.staffName || ''),
    Number(order.totalAmount) || 0,
    String(order.status || 'قيد المراجعة'),
    String(order.date || new Date().toLocaleString('ar-IQ')),
    String(order.createdAt || new Date().toISOString()),
    String(order.deliveryStaffName || ''),
    String(order.deliveredAt || ''),
    String(order.userId || '')
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
  return { success: true, order };
}

export function approveOrder(db: DatabaseSync, orderNumber: string, staffName: string, items: any[], totalAmount: number) {
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber) as any;
  if (!order) throw new Error(`الطلبية ${orderNumber} غير موجودة`);

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
    const isApproved = ['مستلم', 'مسلّم', 'مسلم', 'مسلّمة', 'مسلمة', 'delivered', 'معتمد', 'معتمد للتجهيز', 'مجهزة', 'approved'].includes(st);
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

  const barcode = String(product.barcode || '').trim();
  if (barcode) {
    const existing = db.prepare('SELECT id FROM products WHERE barcode = ?').get(barcode);
    if (existing) throw new Error('مادة بنفس الباركود موجودة مسبقاً');
  }

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
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO products
    (id, name, barcode, company, quantity, min_qty, price, total_price, bonus, expiry_date, form, image, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, barcode, company, quantity, minQty, price, totalPrice, bonus, expiryDate, form, image, createdAt);

  if (quantity > 0) {
    db.prepare(`
      INSERT INTO stock_movements
      (timestamp, product_id, product_name, type, quantity_before, quantity_change, quantity_after, reason, user, order_number, barcode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toLocaleString('ar-IQ'),
      id,
      name,
      'إضافة مادة جديدة',
      0,
      quantity,
      quantity,
      'إضافة مادة دوائية جديدة للمخزن',
      'المذخر',
      '',
      barcode
    );
  }

  exportJsonBackup(db);
  return { success: true, product: { id, name, barcode, company, quantity, minQty, price, totalPrice, bonus, expiryDate, form, image, createdAt } };
}

export function updateProduct(db: DatabaseSync, product: any, stockOperation?: { mode: string; amount: number; reason: string }) {
  const id = String(product.id || '').trim();
  if (!id) throw new Error('معرف المادة مطلوب');

  const oldProd = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as any;
  if (!oldProd) throw new Error('المادة غير موجودة');

  const newQty = Math.max(0, Math.floor(Number(product.quantity) || 0));
  const oldQty = Number(oldProd.quantity) || 0;
  const price = Math.max(0, Number(product.price) || 0);
  const totalPrice = newQty * price;

  db.prepare(`
    UPDATE products 
    SET name = ?, barcode = ?, company = ?, quantity = ?, min_qty = ?, price = ?, total_price = ?, bonus = ?, expiry_date = ?, form = ?, image = ?
    WHERE id = ?
  `).run(
    String(product.name || '').trim(),
    String(product.barcode || '').trim(),
    String(product.company || '').trim(),
    newQty,
    Number(product.minQty) || 5,
    price,
    totalPrice,
    Number(product.bonus) || 0,
    String(product.expiryDate || ''),
    String(product.form || 'Tablet'),
    String(product.image || ''),
    id
  );

  if (newQty !== oldQty) {
    db.prepare(`
      INSERT INTO stock_movements
      (timestamp, product_id, product_name, type, quantity_before, quantity_change, quantity_after, reason, user, order_number, barcode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toLocaleString('ar-IQ'),
      id,
      String(product.name || oldProd.name),
      'تعديل رصيد',
      oldQty,
      newQty - oldQty,
      newQty,
      stockOperation?.reason || 'تعديل يدوي صريح لرصيد المخزون',
      'المذخر',
      '',
      String(product.barcode || oldProd.barcode || '')
    );
  }

  exportJsonBackup(db);
  return { success: true };
}

export function deleteProduct(db: DatabaseSync, productId: string, barcode?: string, name?: string) {
  const prod = db.prepare('SELECT * FROM products WHERE id = ? OR (barcode = ? AND barcode != "") OR name = ?').get(productId, barcode || '', name || '') as any;
  if (prod) {
    if (Number(prod.quantity) > 0) {
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
    }
    db.prepare('DELETE FROM products WHERE id = ?').run(prod.id);
  }

  exportJsonBackup(db);
  return { success: true };
}

export function addStaff(db: DatabaseSync, name: string) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('اسم الموظف مطلوب');
  db.prepare('INSERT OR IGNORE INTO staff (name, created_at) VALUES (?, ?)').run(trimmed, new Date().toISOString());
  exportJsonBackup(db);
  return { success: true, name: trimmed };
}

export function deleteStaff(db: DatabaseSync, name: string) {
  const trimmed = String(name || '').trim();
  db.prepare('DELETE FROM staff WHERE name = ?').run(trimmed);
  exportJsonBackup(db);
  return { success: true };
}
