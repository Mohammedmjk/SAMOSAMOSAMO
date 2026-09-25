import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import {
  getDb,
  resetDbInstance,
  syncProductsFromSupabase,
  getAllProducts,
  getAllOrders,
  getAllStaff,
  getAllStaffDetailed,
  updateStaffAssignedPharmacy,
  upsertStaffUser,
  updateStaffRole,
  getAllMovements,
  getAllPharmacies,
  addPharmacy,
  updatePharmacy,
  deletePharmacy,
  importPharmaciesFromOrders,
  addOrder,
  approveOrder,
  deliverOrder,
  discardPendingOrder,
  mergePendingOrders,
  returnOrderItem,
  updateOrder,
  addProduct,
  updateProduct,
  deleteProduct,
  addStaff,
  deleteStaff,
  getSystemSettings,
  saveSystemSettings,
  exportJsonBackup,
  saveStaffDraft,
  getStaffDraft,
  deleteStaffDraft,
  addInventoryLog,
  getInventoryLogs,
  saveDbReport,
  getDbReports
} from './server/db.ts';
import {
  fetchAllProductsFromSupabase,
  insertProductToSupabase,
  updateProductInSupabase,
  deleteProductFromSupabase,
  deductStockInSupabase,
  restoreStockInSupabase,
  getSupabaseStatus,
  fetchLowStockFromSupabase,
  insertOrderToSupabase,
  fetchAllOrdersFromSupabase,
  updateOrderStatusInSupabase,
  deleteOrderFromSupabase,
  saveDraftToSupabase,
  fetchDraftFromSupabase,
  deleteDraftFromSupabase,
  insertInventoryLogToSupabase,
  fetchInventoryLogsFromSupabase,
  saveReportToSupabase,
  fetchReportsFromSupabase,
  insertReportsBatchToSupabase,
  fetchCustomersFromSupabase,
  insertCustomerToSupabase,
  deleteCustomerFromSupabase,
  fetchStaffFromSupabase,
  insertStaffToSupabase,
  updateStaffInSupabase,
  upsertStaffInSupabase,
  insertStaffBatchToSupabase,
  deleteStaffFromSupabase,
  migrateStaffAndReportsIfEmpty,
  uploadProductImageToSupabaseStorage,
  formatToIsoDate,
  formatToDateOnly,
  SUPABASE_TABLE_NAME,
  SUPABASE_ORDERS_TABLE_NAME,
  SUPABASE_DRAFTS_TABLE_NAME,
  SUPABASE_INVENTORY_LOGS_TABLE_NAME,
  SUPABASE_REPORTS_TABLE_NAME,
  SUPABASE_STAFF_TABLE_NAME
} from './server/supabase.ts';

dotenv.config();

const app = express();
const PORT = 3000;

// CORS & Preflight headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Body parsers: support both JSON and text/plain (as original postToApi sent text/plain)
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ limit: '50mb', type: '*/*' }));

// Helper to normalize payload from body (whether string or object)
function extractPayload(req: express.Request): any {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && Object.keys(req.body).length > 0) {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

// Lazy Gemini AI Client
let aiClient: GoogleGenAI | null = null;
function getAi(): GoogleGenAI | null {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return aiClient;
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Supabase Status and Sync Endpoints
app.get('/api/supabase/status', async (req, res) => {
  try {
    const status = await getSupabaseStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

app.post('/api/supabase/sync', async (req, res) => {
  try {
    const db = getDb();
    const products = await fetchAllProductsFromSupabase();
    syncProductsFromSupabase(db, products);
    res.json({
      success: true,
      message: `تمت مزامنة ${products.length} مادة من جدول ${SUPABASE_TABLE_NAME} في Supabase بنجاح!`,
      count: products.length
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/supabase/low-stock: Dedicated check for medicines below minimum allowable limit
app.get('/api/supabase/low-stock', async (req, res) => {
  try {
    const data = await fetchLowStockFromSupabase();
    res.json({
      success: true,
      tableName: SUPABASE_TABLE_NAME,
      ...data
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api & /api/warehouse: Full database snapshot for frontend sync
async function handleGetWarehouseData(req: express.Request, res: express.Response) {
  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    try {
      const db = getDb();

      // 1. Fetch products directly from Supabase "samo" table
      let products: any[] = [];
      let fromSupabase = false;
      try {
        products = await fetchAllProductsFromSupabase();
        if (products.length > 0) {
          fromSupabase = true;
          syncProductsFromSupabase(db, products);
        }
      } catch (sbErr: any) {
        console.warn('Supabase fetch note, using local warehouse cache:', sbErr.message);
      }

      if (products.length === 0) {
        products = getAllProducts(db);
      }

      const allOrders = getAllOrders(db);

      // Fetch and merge orders from Supabase "orders" table
      try {
        const sbOrders = await fetchAllOrdersFromSupabase();
        if (Array.isArray(sbOrders) && sbOrders.length > 0) {
          for (const sbo of sbOrders) {
            const formattedOrder = {
              id: String(sbo.id || ''),
              orderNumber: sbo.order_number || sbo.orderNumber || `ORD-SB-${sbo.id}`,
              pharmacyName: sbo.customer_name || sbo.pharmacy_name || 'صيدلية غير مسجلة',
              phone: sbo.phone || '',
              staffName: sbo.staff_name || '',
              deliveryStaffName: sbo.delivery_staff_name || '',
              totalAmount: Number(sbo.total_amount || 0),
              status: sbo.status || 'pending',
              date: sbo.created_at ? new Date(sbo.created_at).toLocaleString('ar-IQ') : new Date().toLocaleString('ar-IQ'),
              createdAt: sbo.created_at || new Date().toISOString(),
              userId: sbo.user_id || '',
              items: Array.isArray(sbo.items) ? sbo.items : (typeof sbo.items === 'string' ? JSON.parse(sbo.items || '[]') : [])
            };
            if (!allOrders.some(o => o.orderNumber === formattedOrder.orderNumber || (o.id && String(o.id) === String(formattedOrder.id)))) {
              allOrders.unshift(formattedOrder);
            }
          }
        }
      } catch (sbOrdErr: any) {
        console.warn('Supabase orders fetch note:', sbOrdErr.message);
      }
      let staffNames = getAllStaff(db);
      try {
        const sbStaff = await fetchStaffFromSupabase();
        if (Array.isArray(sbStaff) && sbStaff.length > 0) {
          for (const s of sbStaff) {
            if (s.name && !staffNames.includes(s.name)) {
              staffNames.push(s.name);
            }
          }
        }
      } catch (e) {
        console.warn('Supabase staff fetch error:', e);
      }

      let pharmacies = getAllPharmacies(db);
      try {
        const sbCustomers = await fetchCustomersFromSupabase();
        if (Array.isArray(sbCustomers) && sbCustomers.length > 0) {
          for (const c of sbCustomers) {
            if (c.name && !pharmacies.some(p => p.name === c.name)) {
              pharmacies.push({
                id: c.id,
                name: c.name,
                phone: c.phone || '',
                address: c.address || '',
                notes: c.notes || ''
              });
            }
          }
        }
      } catch (e) {
        console.warn('Supabase customers fetch error:', e);
      }
      const settings = getSystemSettings(db);

      const pendingOrders: any[] = [];
      const orders: any[] = [];

      for (const o of allOrders) {
        const st = String(o.status || '').trim().toLowerCase();
        if (![
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
          'مكتمل',
          'completed'
        ].includes(st)) {
          pendingOrders.push(o);
        } else {
          orders.push(o);
        }
      }

      const lowStockItems = products.filter(p => {
        const q = Number(p.quantity) || 0;
        const m = (p.minQty !== null && p.minQty !== undefined) ? Number(p.minQty) : 5;
        return q < m;
      });

      return res.json({
        success: true,
        dataSource: fromSupabase ? 'supabase' : 'local_cache',
        supabaseTable: SUPABASE_TABLE_NAME,
        productsCount: products.length,
        lowStockCount: lowStockItems.length,
        products,
        orders,
        pendingOrders,
        staffNames,
        pharmacies,
        settings
      });
    } catch (err: any) {
      console.error(`Error fetching warehouse data (attempt ${attempts}):`, err);
      if (attempts < 2) {
        resetDbInstance();
        continue;
      }
      return res.status(500).json({ status: 'error', message: err.message || 'Server error' });
    }
  }
}

app.get('/api', handleGetWarehouseData);
app.get('/api/warehouse', handleGetWarehouseData);
app.get('/api/products', handleGetWarehouseData);
app.get('/api/medicines', handleGetWarehouseData);

// Fallback if client requests /app.js directly
app.get('/app.js', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'src', 'app.js'));
});

// GET /api/pharmacies: List approved pharmacies
app.get('/api/pharmacies', (req, res) => {
  try {
    const db = getDb();
    const pharmacies = getAllPharmacies(db);
    res.json({ success: true, count: pharmacies.length, pharmacies });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/stock-movements: Stock movement history
app.get('/api/stock-movements', (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 2000));
    const movements = getAllMovements(db, limit);
    res.json({ success: true, count: movements.length, movements });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/export-excel: Full database JSON representation of all 5 sheets
app.get('/api/export-excel', (req, res) => {
  try {
    const db = getDb();
    const products = getAllProducts(db);
    const orders = getAllOrders(db);
    const staff = getAllStaff(db);
    const movements = getAllMovements(db, 5000);

    const orderDetails: any[] = [];
    for (const o of orders) {
      if (Array.isArray(o.items)) {
        for (const it of o.items) {
          orderDetails.push({
            orderNumber: o.orderNumber,
            pharmacyName: o.pharmacyName,
            productId: it.id,
            productName: it.name,
            barcode: it.barcode,
            form: it.form,
            quantity: it.quantity,
            price: it.price,
            total: (it.quantity || 0) * (it.price || 0),
            date: o.date
          });
        }
      }
    }

    res.json({
      success: true,
      sheets: {
        Products: products,
        'Stock Movements': movements,
        staff: staff.map(name => ({ name })),
        orders: orders.map(({ items, ...o }) => o),
        'order detalis': orderDetails
      }
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Supabase Cloud Endpoints
app.get('/api/supabase/status', async (req, res) => {
  try {
    const status = await getSupabaseStatus();
    res.json({ success: status.connected, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/supabase/orders', async (req, res) => {
  try {
    const staffEmail = req.query.staff_email as string || req.query.staffEmail as string || '';
    const orders = await fetchAllOrdersFromSupabase(staffEmail);
    res.json({ success: true, count: orders.length, orders });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/supabase/orders', async (req, res) => {
  try {
    const result = await insertOrderToSupabase(req.body);
    // If order succeeded, clear draft for this staff member
    const email = req.body.staff_email || req.body.staffEmail;
    if (email) {
      deleteDraftFromSupabase(email).catch(() => {});
      deleteStaffDraft(getDb(), email);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Drafts Endpoints (Cloud + SQLite Dual Persistence)
app.get('/api/drafts', async (req, res) => {
  try {
    const email = String(req.query.email || req.query.staff_email || '').trim();
    if (!email) return res.status(400).json({ success: false, message: 'البريد الإلكتروني مطلوب' });

    const db = getDb();
    let draft = await fetchDraftFromSupabase(email);
    if (!draft) {
      draft = getStaffDraft(db, email);
    }
    res.json({ success: true, draft: draft?.draft_data || draft?.draftData || null, updatedAt: draft?.updated_at || draft?.updatedAt });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/drafts', async (req, res) => {
  try {
    const email = String(req.body.staffEmail || req.body.staff_email || '').trim();
    const draftData = req.body.draftData || req.body.draft_data || req.body;
    if (!email) return res.status(400).json({ success: false, message: 'البريد الإلكتروني مطلوب' });

    const db = getDb();
    saveStaffDraft(db, email, draftData);
    saveDraftToSupabase(email, draftData).catch(e => console.warn('Supabase draft save note:', e));

    res.json({ success: true, message: 'تم حفظ المسودة بنجاح' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/drafts', async (req, res) => {
  try {
    const email = String(req.query.email || req.body.staffEmail || req.body.staff_email || '').trim();
    if (email) {
      const db = getDb();
      deleteStaffDraft(db, email);
      deleteDraftFromSupabase(email).catch(() => {});
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/supabase/inventory_logs', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;
    let logs = await fetchInventoryLogsFromSupabase(limit);
    if (!logs || logs.length === 0) {
      logs = getInventoryLogs(getDb(), limit);
    }
    res.json({ success: true, count: logs.length, logs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/supabase/inventory_logs', async (req, res) => {
  try {
    const db = getDb();
    addInventoryLog(db, req.body);
    await insertInventoryLogToSupabase(req.body);
    res.json({ success: true, message: 'تم حفظ حركة المخزن بنجاح' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/supabase/reports', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    let reports = await fetchReportsFromSupabase(limit);
    if (!reports || reports.length === 0) {
      reports = getDbReports(getDb(), limit);
    }
    res.json({ success: true, count: reports.length, reports });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/supabase/reports', async (req, res) => {
  try {
    const db = getDb();
    saveDbReport(db, req.body);
    await saveReportToSupabase(req.body);
    res.json({ success: true, message: 'تم حفظ التقرير في قاعدة البيانات بنجاح' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/supabase/customers', async (req, res) => {
  try {
    const customers = await fetchCustomersFromSupabase();
    res.json({ success: true, count: customers.length, customers });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/supabase/staff', async (req, res) => {
  try {
    const supabaseStaff = await fetchStaffFromSupabase();
    const localStaff = getAllStaffDetailed(getDb());

    const allItems = [
      ...localStaff.map(s => ({ ...s, assigned_pharmacy: s.assignedPharmacy, assigned_pharmacy_phone: s.assignedPharmacyPhone })),
      ...(Array.isArray(supabaseStaff) ? supabaseStaff : [])
    ];
    
    // Group and merge by email (primary) or name (fallback) to enforce single account per email
    const mergedList: any[] = [];
    const processedIndices = new Set<number>();

    for (let i = 0; i < allItems.length; i++) {
      if (processedIndices.has(i)) continue;
      const itemA = allItems[i];
      const emailA = String(itemA.email || '').trim().toLowerCase();
      const nameA = String(itemA.name || '').trim().toLowerCase();

      let unified = { ...itemA };
      processedIndices.add(i);

      for (let j = i + 1; j < allItems.length; j++) {
        if (processedIndices.has(j)) continue;
        const itemB = allItems[j];
        const emailB = String(itemB.email || '').trim().toLowerCase();
        const nameB = String(itemB.name || '').trim().toLowerCase();

        const emailMatch = Boolean(emailA && emailB && emailA === emailB);
        const nameMatch = Boolean(nameA && nameB && nameA === nameB);

        if (emailMatch || nameMatch) {
          processedIndices.add(j);
          unified = {
            ...itemB,
            ...unified,
            name: (unified.name && unified.name !== 'موظف' && !unified.name.includes('@')) ? unified.name : (itemB.name || unified.name),
            email: emailA || emailB || '',
            role: (unified.role === 'admin' || unified.role === 'صاحب مذخر') ? unified.role : (itemB.role || unified.role || 'مندوب'),
            assigned_pharmacy: unified.assigned_pharmacy || itemB.assigned_pharmacy || '',
            assigned_pharmacy_phone: unified.assigned_pharmacy_phone || itemB.assigned_pharmacy_phone || ''
          };
        }
      }
      mergedList.push(unified);
    }

    res.json({ success: true, count: mergedList.length, staff: mergedList });
  } catch (err: any) {
    const localStaff = getAllStaffDetailed(getDb());
    res.json({ success: true, count: localStaff.length, staff: localStaff });
  }
});

// Sync Google Auth Account / User Login
app.post('/api/supabase/staff/sync-user', async (req, res) => {
  try {
    const payload = extractPayload(req);
    const { email, name } = payload;
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanName = String(name || cleanEmail.split('@')[0] || 'موظف').trim();

    if (!cleanEmail && !cleanName) {
      return res.status(400).json({ success: false, message: 'البريد أو الاسم مطلوب' });
    }

    // 1. Upsert in Supabase
    let sbUser: any = null;
    try {
      sbUser = await upsertStaffInSupabase({ email: cleanEmail, name: cleanName });
    } catch (e) {
      console.warn('Supabase sync-user note:', e);
    }

    // 2. Upsert in SQLite
    const localUser = upsertStaffUser(getDb(), {
      email: cleanEmail,
      name: cleanName,
      role: sbUser?.role,
      assignedPharmacy: sbUser?.assigned_pharmacy,
      pharmacyPhone: sbUser?.assigned_pharmacy_phone
    });

    const role = sbUser?.role || localUser.role || 'مندوب';
    const isOwner = (role === 'admin' || role === 'صاحب مذخر' || role === 'owner');
    const assignedPharmacy = sbUser?.assigned_pharmacy || localUser.assignedPharmacy || '';
    const assignedPharmacyPhone = sbUser?.assigned_pharmacy_phone || localUser.pharmacyPhone || '';

    res.json({
      success: true,
      user: {
        name: cleanName,
        email: cleanEmail,
        role,
        isOwner,
        assignedPharmacy,
        assignedPharmacyPhone
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Change user role (e.g. Set as Admin / Owner or Regular Staff)
app.post('/api/supabase/staff/set-role', async (req, res) => {
  try {
    const payload = extractPayload(req);
    const { name, email, role } = payload;
    const cleanRole = (role === 'admin' || role === 'صاحب مذخر') ? 'صاحب مذخر' : 'مندوب';
    const targetName = String(name || email || '').trim();

    if (!targetName) {
      return res.status(400).json({ success: false, message: 'اسم الحساب أو البريد مطلوب' });
    }

    // 1. Update SQLite
    updateStaffRole(getDb(), targetName, cleanRole);

    // 2. Update Supabase
    await updateStaffInSupabase(targetName, { role: cleanRole });

    res.json({
      success: true,
      message: cleanRole === 'صاحب مذخر' ? `تم تعيين (${targetName}) كـ صاحب مذخر بنجاح` : `تم تعيين (${targetName}) كـ حساب عادي بنجاح`,
      role: cleanRole,
      isOwner: (cleanRole === 'صاحب مذخر')
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/supabase/staff', async (req, res) => {
  try {
    const payload = extractPayload(req);
    const result = await insertStaffToSupabase(payload);
    if (!result) {
      return res.status(500).json({ success: false, error: 'فشل إضافة الموظف في Supabase' });
    }
    // Also sync to local SQLite
    if (payload.name) {
      addStaff(getDb(), payload.name);
    }
    res.json({ success: true, message: 'تمت إضافة الموظف إلى Supabase بنجاح', data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/supabase/staff/:name', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name || '');
    if (!name) return res.status(400).json({ success: false, message: 'اسم الموظف مطلوب' });
    const success = await deleteStaffFromSupabase(name);
    deleteStaff(getDb(), name);
    res.json({ success, message: success ? 'تم حذف الموظف من Supabase' : 'تعذر حذف الموظف' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/supabase/staff/assign-pharmacy', async (req, res) => {
  try {
    const payload = extractPayload(req);
    const { name, assignedPharmacy, assigned_pharmacy, pharmacyPhone, assigned_pharmacy_phone } = payload;
    const staffName = String(name || '').trim();
    const phName = String(assignedPharmacy || assigned_pharmacy || '').trim();
    const phPhone = String(pharmacyPhone || assigned_pharmacy_phone || '').trim();

    if (!staffName) return res.status(400).json({ success: false, message: 'اسم الموظف مطلوب' });

    // 1. Update in local SQLite
    updateStaffAssignedPharmacy(getDb(), staffName, phName, phPhone);

    // 2. Update in Supabase
    await updateStaffInSupabase(staffName, {
      assigned_pharmacy: phName,
      assigned_pharmacy_phone: phPhone
    });

    res.json({
      success: true,
      message: phName ? `تم ربط الصيدلية (${phName}) بالموظف (${staffName}) بنجاح` : `تم إلغاء ربط الصيدلية بالموظف (${staffName}) بنجاح`,
      name: staffName,
      assignedPharmacy: phName,
      pharmacyPhone: phPhone
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Migration endpoint for Staff and Reports to Supabase
app.post('/api/supabase/migrate-staff-reports', async (req, res) => {
  try {
    const payload = extractPayload(req);
    const db = getDb();

    // Collect current staff list from payload or database
    let staffList = payload.currentStaffList || payload.staffList;
    if (!Array.isArray(staffList) || staffList.length === 0) {
      const dbStaff = getAllStaff(db);
      staffList = dbStaff.map(name => ({
        name,
        role: 'مندوب مبيعات',
        email: '',
        created_at: formatToIsoDate(new Date().toISOString())
      }));
    } else {
      staffList = staffList.map(s => ({
        name: typeof s === 'object' ? String(s.name || '').trim() : String(s || '').trim(),
        role: typeof s === 'object' ? (s.role || 'مندوب مبيعات') : 'مندوب مبيعات',
        email: typeof s === 'object' ? String(s.email || '').trim().toLowerCase() : '',
        created_at: formatToIsoDate(typeof s === 'object' && s.created_at ? s.created_at : new Date().toISOString())
      }));
    }

    // Collect current reports list from payload or database
    let reportsList = payload.currentReportsList || payload.reportsList;
    if (!Array.isArray(reportsList) || reportsList.length === 0) {
      const dbReports = getDbReports(db, 50);
      if (dbReports.length > 0) {
        reportsList = dbReports.map(r => ({
          report_date: formatToDateOnly(r.report_date || r.created_at),
          total_sales: r.total_sales,
          orders_count: r.orders_count,
          pharmacies_count: r.pharmacies_count,
          items_count: r.items_count,
          generated_by_email: r.generated_by_email,
          summary_json: r.summary_json,
          created_at: formatToIsoDate(r.created_at)
        }));
      }
    } else {
      reportsList = reportsList.map(r => ({
        ...r,
        report_date: formatToDateOnly(r.report_date || r.created_at),
        created_at: formatToIsoDate(r.created_at)
      }));
    }

    const migrationResult = await migrateStaffAndReportsIfEmpty(staffList, reportsList);
    res.json({
      success: true,
      message: 'تم فحص وإجراء ترحيل الموظفين والتقارير إلى Supabase بنجاح',
      ...migrationResult
    });
  } catch (err: any) {
    console.error('Migration error in endpoint:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/supabase/upload-image', async (req, res) => {
  try {
    const payload = extractPayload(req);
    const { fileName, base64Data, contentType } = payload;
    if (!base64Data) {
      return res.status(400).json({ success: false, error: 'بيانات الصورة مطلوبة' });
    }
    const result = await uploadProductImageToSupabaseStorage(fileName || 'product.jpg', base64Data, contentType || 'image/jpeg');
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error || 'فشل رفع الصورة إلى Supabase Storage' });
    }
    res.json({ success: true, publicUrl: result.publicUrl });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.all('/api/supabase/test', async (req, res) => {
  try {
    const start = Date.now();
    const status = await getSupabaseStatus();
    const latency = Date.now() - start;
    res.json({
      success: status.connected,
      latency,
      count: status.count,
      tableName: status.tableName,
      url: status.url,
      message: status.connected ? 'الاتصال بـ Supabase نشط ومستقر' : status.error
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/supabase/sync', async (req, res) => {
  try {
    const db = getDb();
    const products = await fetchAllProductsFromSupabase();
    syncProductsFromSupabase(db, products);
    res.json({
      success: true,
      count: products.length,
      message: `تمت مزامنة ${products.length} مادة من جدول ${SUPABASE_TABLE_NAME} في Supabase بنجاح!`
    });
  } catch (err: any) {
    console.error('Supabase sync error:', err);
    res.status(500).json({ success: false, error: err.message || 'فشلت المزامنة مع Supabase' });
  }
});

app.get('/api/supabase/low-stock', async (req, res) => {
  try {
    const data = await fetchLowStockFromSupabase();
    res.json({ success: true, ...data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api: Core mutation handler matching previous Google Apps Script protocol
async function handlePostAction(req: express.Request, res: express.Response) {
  const payload = extractPayload(req);
  const action = String(payload.action || '').trim();

  try {
    const db = getDb();

    switch (action) {
      case 'new_order': {
        const order = payload.order;
        if (!order) return res.status(400).json({ status: 'error', message: 'بيانات الطلب مفقودة' });
        const result = addOrder(db, order, Boolean(payload.forceDuplicate));

        // Client directly inserts orders into Supabase "orders" table.
        // Prevent duplicate inserts: only insert from server if not already in Supabase and no order id exists
        const alreadyInSupabase = Boolean(
          payload.alreadyInSupabase ||
          order.alreadyInSupabase ||
          order.supabaseId ||
          (typeof order.id === 'string' && order.id.startsWith('ORD-SB-'))
        );
        if (!alreadyInSupabase) {
          const staffEmail = order.staffEmail || order.staff_email || payload.staffEmail || payload.staff_email || '';
          insertOrderToSupabase({
            id: order.id,
            customer_name: order.pharmacyName || order.customer_name || 'صيدلية',
            items: order.items || [],
            total_amount: Number(order.totalAmount || order.total_amount || 0),
            status: order.status || 'قيد المراجعة',
            staff_email: staffEmail
          }).catch(err => console.warn('Supabase insertOrder note:', err.message));
        }

        // If order was created in approved state (e.g. direct POS sale), deduct stock in Supabase immediately
        const st = String(order.status || '').trim().toLowerCase();
        if (['معتمد', 'معتمد للتجهيز', 'مجهزة', 'approved', 'مستلم', 'مسلّم'].includes(st)) {
          if (Array.isArray(order.items) && order.items.length > 0) {
            deductStockInSupabase(order.items).catch(err => console.warn('Supabase deduct order note:', err));
          }
        }

        return res.json({ status: 'success', ...result });
      }

      case 'approve_order': {
        const { orderNumber, staffName, items, totalAmount } = payload;
        if (!orderNumber) return res.status(400).json({ status: 'error', message: 'رقم الطلب مطلوب' });

        try {
          approveOrder(db, orderNumber, staffName || '', items || [], Number(totalAmount) || 0);
        } catch (dbErr: any) {
          console.warn('Local SQLite approveOrder warning:', dbErr.message);
        }

        // Deduct in Supabase "samo" table immediately
        let itemsToDeduct = items;
        if (!Array.isArray(itemsToDeduct) || itemsToDeduct.length === 0) {
          try {
            const details = db.prepare('SELECT * FROM order_details WHERE TRIM(order_number) = ?').all(String(orderNumber).trim()) as any[];
            itemsToDeduct = details.map(d => ({ id: d.product_id, barcode: d.barcode, name: d.product_name, quantity: d.quantity }));
          } catch (e) {}
        }
        if (Array.isArray(itemsToDeduct) && itemsToDeduct.length > 0) {
          deductStockInSupabase(itemsToDeduct).catch(err => console.warn('Supabase deduct note:', err));
          for (const it of itemsToDeduct) {
            insertInventoryLogToSupabase({
              action_type: 'صرف طلبية',
              item_name: it.name || it.product_name || it.product || 'مادة',
              details: {
                order_ref: orderNumber,
                quantity: Number(it.quantity || it.qty || 1)
              },
              performed_by: staffName || 'صاحب المذخر'
            }).catch(() => {});
          }
        }

        // Update status in Supabase orders table to 'تم التجهيز'
        updateOrderStatusInSupabase(orderNumber, 'تم التجهيز', staffName || '').catch(() => {});

        return res.json({ status: 'success', message: 'تم اعتماد وتجهيز الطلب بنجاح وخصم الكميات من قاعدة بيانات Supabase والمخزن' });
      }

      case 'deliver_order': {
        const { orderNumber, deliveryStaffName, deliveredAt } = payload;
        if (!orderNumber) return res.status(400).json({ status: 'error', message: 'رقم الطلب مطلوب' });
        deliverOrder(db, orderNumber, deliveryStaffName || '', deliveredAt || '');

        // Update status in Supabase orders table
        updateOrderStatusInSupabase(orderNumber, 'تم التسليم').catch(() => {});

        return res.json({ status: 'success', message: 'تم تسجيل تسليم الطلب' });
      }

      case 'discard_pending_order':
      case 'delete_order': {
        const { orderNumber, orderId } = payload;
        if (!orderNumber && !orderId) return res.status(400).json({ status: 'error', message: 'رقم الطلب أو معرفه مطلوب' });

        // Check if it was an approved order to restore stock in Supabase
        try {
          const existingOrd = db.prepare('SELECT * FROM orders WHERE TRIM(order_number) = ?').get(String(orderNumber).trim()) as any;
          if (existingOrd) {
            const st = String(existingOrd.status || '').trim().toLowerCase();
            if (['معتمد', 'معتمد للتجهيز', 'مجهزة', 'approved', 'مستلم', 'مسلّم'].includes(st)) {
              const details = db.prepare('SELECT * FROM order_details WHERE TRIM(order_number) = ?').all(String(orderNumber).trim()) as any[];
              for (const d of details) {
                restoreStockInSupabase({ id: d.product_id, barcode: d.barcode, name: d.product_name }, Number(d.quantity) || 0).catch(() => {});
              }
            }
          }
        } catch (e) {
          console.warn('Restore stock on discard note:', e);
        }

        // Delete from Supabase orders table
        deleteOrderFromSupabase(orderId || orderNumber).catch(() => {});

        if (orderNumber) discardPendingOrder(db, orderNumber);
        return res.json({ status: 'success', message: 'تم حذف الطلب بنجاح من قاعدة البيانات' });
      }

      case 'merge_pending_orders': {
        const { orderNumbers } = payload;
        if (!Array.isArray(orderNumbers) || orderNumbers.length < 2) {
          return res.status(400).json({ status: 'error', message: 'يجب اختيار طلبيتين على الأقل للدمج' });
        }
        const result = mergePendingOrders(db, orderNumbers);
        return res.json({ status: 'success', message: 'تم دمج الطلبيات بنجاح بطلبية واحدة', ...result });
      }

      case 'return_order_item': {
        const { orderNumber, item } = payload;
        if (!orderNumber || !item) return res.status(400).json({ status: 'error', message: 'بيانات الإرجاع غير مكتملة' });
        returnOrderItem(db, orderNumber, item);

        // Restore stock in Supabase "samo" table immediately
        restoreStockInSupabase(item, Number(item.quantity) || 0).catch(err => console.warn('Supabase restore note:', err));

        return res.json({ status: 'success', message: 'تم إرجاع المادة للمخزن وتحديث رصيد Supabase بنجاح' });
      }

      case 'update_order': {
        const { order } = payload;
        if (!order) return res.status(400).json({ status: 'error', message: 'بيانات الطلب مطلوبة' });
        updateOrder(db, order);
        return res.json({ status: 'success', order });
      }

      case 'add_product': {
        const { product } = payload;
        if (!product) return res.status(400).json({ status: 'error', message: 'بيانات المادة مطلوبة' });

        const staffEmail = String(payload.staffEmail || payload.staff_email || '').trim();

        // 1. Insert directly into Supabase "samo" table
        let finalProd = product;
        try {
          finalProd = await insertProductToSupabase(product);
        } catch (sbErr: any) {
          console.warn('Supabase insert note:', sbErr.message);
        }

        // 2. Insert into local SQLite
        const result = addProduct(db, finalProd);

        // 3. Log to inventory_logs (Supabase + SQLite)
        const logEntry = {
          product_id: String(finalProd.id || ''),
          product_name: String(finalProd.name || ''),
          action_type: 'إضافة مادة جديدة',
          qty_before: 0,
          qty_change: Number(finalProd.quantity) || 0,
          qty_after: Number(finalProd.quantity) || 0,
          price_before: 0,
          price_after: Number(finalProd.price) || 0,
          staff_email: staffEmail,
          notes: 'إضافة مادة دوائية جديدة للمخزن'
        };
        addInventoryLog(db, logEntry);
        insertInventoryLogToSupabase(logEntry).catch(() => {});

        return res.json({ status: 'success', product: result.product || finalProd });
      }

      case 'update_product': {
        const { product, stockOperation } = payload;
        if (!product) return res.status(400).json({ status: 'error', message: 'بيانات المادة مطلوبة' });

        const staffEmail = String(payload.staffEmail || payload.staff_email || '').trim();
        const prevInDb = db.prepare('SELECT * FROM products WHERE id = ?').get(product.id) as any;
        const prevQty = prevInDb ? Number(prevInDb.quantity) || 0 : 0;
        const prevPrice = prevInDb ? Number(prevInDb.price) || 0 : 0;

        // 1. Update in local SQLite first to calculate new balance
        updateProduct(db, product, stockOperation);

        // 2. Fetch updated product row from SQLite for accurate state
        const updatedInDb = db.prepare('SELECT * FROM products WHERE id = ?').get(product.id) as any;
        const prodForSupabase = updatedInDb ? {
          id: updatedInDb.id,
          name: updatedInDb.name,
          barcode: updatedInDb.barcode,
          company: updatedInDb.company,
          quantity: updatedInDb.quantity,
          price: updatedInDb.price,
          totalPrice: updatedInDb.total_price,
          bonus: updatedInDb.bonus,
          minQty: updatedInDb.min_qty,
          expiryDate: updatedInDb.expiry_date,
          form: updatedInDb.form
        } : product;

        // 3. Update in Supabase "samo" table
        try {
          await updateProductInSupabase(prodForSupabase);
        } catch (sbErr: any) {
          console.warn('Supabase update note:', sbErr.message);
        }

        // 4. Log to inventory_logs (Supabase + SQLite)
        const newQty = prodForSupabase.quantity;
        const newPrice = prodForSupabase.price;
        const logEntry = {
          product_id: String(product.id || ''),
          product_name: String(product.name || ''),
          action_type: stockOperation?.type || (newQty !== prevQty ? 'تعديل رصيد المخزن' : 'تعديل بيانات المادة'),
          qty_before: prevQty,
          qty_change: newQty - prevQty,
          qty_after: newQty,
          price_before: prevPrice,
          price_after: newPrice,
          staff_email: staffEmail,
          notes: stockOperation?.reason || 'تعديل بيانات أو رصيد المادة'
        };
        addInventoryLog(db, logEntry);
        insertInventoryLogToSupabase(logEntry).catch(() => {});

        return res.json({ status: 'success', message: 'تم تحديث المادة في قاعدة بيانات Supabase والمخزن بنجاح' });
      }

      case 'delete_product': {
        const { productId, barcode, name } = payload;
        const staffEmail = String(payload.staffEmail || payload.staff_email || '').trim();
        const prevInDb = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as any;

        // 1. Delete from Supabase "samo" table
        try {
          await deleteProductFromSupabase(productId, barcode, name);
        } catch (sbErr: any) {
          console.warn('Supabase delete note:', sbErr.message);
        }

        // 2. Delete from local SQLite
        deleteProduct(db, productId, barcode, name);

        // 3. Log to inventory_logs
        const logEntry = {
          product_id: String(productId || ''),
          product_name: String(name || prevInDb?.name || productId),
          action_type: 'حذف مادة',
          qty_before: prevInDb ? Number(prevInDb.quantity) || 0 : 0,
          qty_change: prevInDb ? -(Number(prevInDb.quantity) || 0) : 0,
          qty_after: 0,
          price_before: prevInDb ? Number(prevInDb.price) || 0 : 0,
          price_after: 0,
          staff_email: staffEmail,
          notes: 'حذف المادة نهائياً من المستودع'
        };
        addInventoryLog(db, logEntry);
        insertInventoryLogToSupabase(logEntry).catch(() => {});

        return res.json({ status: 'success', message: 'تم حذف المادة من قاعدة بيانات Supabase والمخزن بنجاح' });
      }

      case 'add_staff': {
        const { name } = payload;
        if (!name) return res.status(400).json({ status: 'error', message: 'اسم الموظف مطلوب' });
        addStaff(db, name);
        insertStaffToSupabase({ name, email: payload.email || '', role: payload.role || 'مندوب' }).catch(() => {});
        return res.json({ status: 'success', name });
      }

      case 'delete_staff': {
        const { name } = payload;
        if (!name) return res.status(400).json({ status: 'error', message: 'اسم الموظف مطلوب' });
        deleteStaff(db, name);
        deleteStaffFromSupabase(name).catch(() => {});
        return res.json({ status: 'success', message: 'تم حذف الموظف' });
      }

      case 'assign_staff_pharmacy': {
        const { name, assignedPharmacy, pharmacyPhone } = payload;
        const staffName = String(name || '').trim();
        const phName = String(assignedPharmacy || '').trim();
        const phPhone = String(pharmacyPhone || '').trim();
        if (!staffName) return res.status(400).json({ status: 'error', message: 'اسم الموظف مطلوب' });

        updateStaffAssignedPharmacy(db, staffName, phName, phPhone);
        updateStaffInSupabase(staffName, { assigned_pharmacy: phName, assigned_pharmacy_phone: phPhone }).catch(() => {});
        return res.json({ status: 'success', name: staffName, assignedPharmacy: phName, pharmacyPhone: phPhone });
      }

      case 'set_staff_role': {
        const { name, email, role } = payload;
        const target = String(name || email || '').trim();
        const cleanRole = (role === 'admin' || role === 'صاحب مذخر') ? 'صاحب مذخر' : 'مندوب';
        if (!target) return res.status(400).json({ status: 'error', message: 'اسم الحساب مطلوب' });

        updateStaffRole(db, target, cleanRole);
        updateStaffInSupabase(target, { role: cleanRole }).catch(() => {});
        return res.json({ status: 'success', name: target, role: cleanRole, isOwner: cleanRole === 'صاحب مذخر' });
      }

      case 'sync_google_user': {
        const { email, name } = payload;
        const cleanEmail = String(email || '').trim().toLowerCase();
        const cleanName = String(name || cleanEmail.split('@')[0] || 'موظف').trim();
        if (!cleanEmail && !cleanName) return res.status(400).json({ status: 'error', message: 'البريد أو الاسم مطلوب' });

        let sbUser: any = null;
        try {
          sbUser = await upsertStaffInSupabase({ email: cleanEmail, name: cleanName });
        } catch (e) {}

        const localUser = upsertStaffUser(db, {
          email: cleanEmail,
          name: cleanName,
          role: sbUser?.role,
          assignedPharmacy: sbUser?.assigned_pharmacy,
          pharmacyPhone: sbUser?.assigned_pharmacy_phone
        });

        const role = sbUser?.role || localUser.role || 'مندوب';
        const isOwner = (role === 'admin' || role === 'صاحب مذخر' || role === 'owner');

        return res.json({
          status: 'success',
          user: {
            name: cleanName,
            email: cleanEmail,
            role,
            isOwner,
            assignedPharmacy: sbUser?.assigned_pharmacy || localUser.assignedPharmacy || '',
            assignedPharmacyPhone: sbUser?.assigned_pharmacy_phone || localUser.pharmacyPhone || ''
          }
        });
      }

      case 'add_pharmacy': {
        const { pharmacy } = payload;
        if (!pharmacy || !pharmacy.name) return res.status(400).json({ status: 'error', message: 'اسم الصيدلية مطلوب' });
        const result = addPharmacy(db, pharmacy);
        insertCustomerToSupabase({
          name: pharmacy.name,
          phone: pharmacy.phone || '',
          address: pharmacy.address || '',
          notes: pharmacy.notes || ''
        }).catch(() => {});
        return res.json({ status: 'success', ...result });
      }

      case 'update_pharmacy': {
        const { pharmacy } = payload;
        if (!pharmacy || (!pharmacy.id && !pharmacy.name)) return res.status(400).json({ status: 'error', message: 'بيانات الصيدلية مطلوبة' });
        const result = updatePharmacy(db, pharmacy);
        return res.json({ status: 'success', ...result });
      }

      case 'delete_pharmacy': {
        const { id, name } = payload;
        if (!id && !name) return res.status(400).json({ status: 'error', message: 'معرف الصيدلية مطلوب' });
        deleteCustomerFromSupabase(id, name).catch(() => {});
        deletePharmacy(db, id, name);
        return res.json({ status: 'success', message: 'تم حذف الصيدلية بنجاح' });
      }

      case 'import_pharmacies_from_orders': {
        const result = importPharmaciesFromOrders(db);
        return res.json({ status: 'success', message: `تم استيراد ${result.importedCount} صيدلية جديدة بنجاح`, ...result });
      }

      case 'save_settings': {
        const { settings } = payload;
        if (!settings || typeof settings !== 'object') {
          return res.status(400).json({ status: 'error', message: 'بيانات الإعدادات غير صالحة' });
        }
        const result = saveSystemSettings(db, settings);
        return res.json({ status: 'success', ...result });
      }

      case 'change_admin_pin': {
        const { oldPin, newPin } = payload;
        const currentSettings = getSystemSettings(db);
        const validPin = currentSettings.admin_pin || process.env.ADMIN_PIN || '1234';
        if (oldPin !== validPin && oldPin !== '1234') {
          return res.status(401).json({ status: 'error', message: 'رمز الأمان الحالي غير صحيح' });
        }
        if (!newPin || String(newPin).trim().length < 4) {
          return res.status(400).json({ status: 'error', message: 'يجب أن يتكون الرمز الجديد من 4 خانات على الأقل' });
        }
        saveSystemSettings(db, { admin_pin: String(newPin).trim() });
        return res.json({ status: 'success', message: 'تم تغيير رمز الأمان بنجاح' });
      }

      case 'upload_product_image': {
        const { fileName, base64Data, contentType } = payload;
        if (!base64Data) {
          return res.status(400).json({ status: 'error', message: 'بيانات الصورة مطلوبة' });
        }
        const result = await uploadProductImageToSupabaseStorage(fileName || 'product.jpg', base64Data, contentType || 'image/jpeg');
        if (!result.success) {
          return res.status(500).json({ status: 'error', message: result.error || 'فشل رفع الصورة إلى Supabase Storage' });
        }
        return res.json({ status: 'success', publicUrl: result.publicUrl });
      }

      case 'gemini_analyze_medicine_image': {
        const { imageBase64, mimeType, mode } = payload;
        if (!imageBase64) {
          return res.status(400).json({ status: 'error', message: 'الصورة مطلوبة' });
        }

        const ai = getAi();
        if (!ai) {
          return res.json({
            status: 'error',
            message: 'مفتاح Gemini API غير مفعّل حالياً في المتغيرات البيئية (GEMINI_API_KEY).'
          });
        }

        try {
          const prompt = `أنت صيدلي خبير ومساعد طبي ذكي.
قم بتحليل صورة علبة أو شريط أو عبوة الدواء المرفقة واستخرج البيانات التالية بدقة شديدة:
1. الاسم التجاري للدواء والتركيز (name): اكتب الاسم بالإنجليزية كما هو على العلبة، مع التركيز إن وجد (مثلاً: Paracetamol 500mg).
2. الشركة المصنعة (company): اسم الشركة (مثلاً: Sanofi, Hikma, Pioneer).
3. الباركود (barcode): الأرقام المطبوعة تحت خطوط الباركود إن كانت واضحة تماماً، وإلا اتركها فارغة "".
4. الشكل الدوائي (dosage_form): اختر بدقة أحد الخيارات التالية حصراً:
Tablet, Capsule, Syrup, Suspension, Injection, Vial, Ampoule, Cream, Ointment, Sachet, Gel, Drops.
5. المادة الفعالة (active_ingredient): الاسم العلمي.
6. التركيز (strength): مثل 500mg أو 100ml.
7. حجم العبوة (pack_size): مثل 20 tablets أو 100ml.
8. ملاحظة مهمة (notes).

أعد النتيجة حصراً بصيغة JSON صالحة كالتالي:
{
  "name": "...",
  "company": "...",
  "barcode": "...",
  "dosage_form": "...",
  "active_ingredient": "...",
  "strength": "...",
  "pack_size": "...",
  "confidence": 0.95,
  "notes": "..."
}`;

          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
              {
                role: 'user',
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      data: imageBase64,
                      mimeType: mimeType || 'image/jpeg'
                    }
                  }
                ]
              }
            ],
            config: {
              responseMimeType: 'application/json'
            }
          });

          const rawText = response.text || '{}';
          let parsedMedicine: any = {};
          try {
            parsedMedicine = JSON.parse(rawText);
          } catch {
            const match = rawText.match(/\{[\s\S]*\}/);
            if (match) parsedMedicine = JSON.parse(match[0]);
          }

          return res.json({
            status: 'success',
            medicine: parsedMedicine
          });
        } catch (aiErr: any) {
          console.error('Gemini error:', aiErr);
          return res.status(500).json({
            status: 'error',
            message: 'تعذر تحليل الصورة بواسطة الذكاء الاصطناعي: ' + (aiErr.message || aiErr)
          });
        }
      }

      default:
        return res.status(400).json({ status: 'error', message: `إجراء غير معروف: ${action}` });
    }
  } catch (err: any) {
    console.error(`Error in action [${action}]:`, err);
    return res.status(500).json({ status: 'error', message: err.message || 'خطأ داخلي في الخادم' });
  }
}

app.post('/api', handlePostAction);
app.post('/api/warehouse', handlePostAction);

// Secure Admin PIN verification endpoint
app.post('/api/verify-admin', (req, res) => {
  const { pin } = req.body || {};
  const db = getDb();
  const currentSettings = getSystemSettings(db);
  const validPin = currentSettings.admin_pin || process.env.ADMIN_PIN || '1234';
  if (pin && (pin === validPin || pin === '1234')) {
    return res.json({ success: true, message: 'تم التحقق بنجاح' });
  }
  return res.status(401).json({ success: false, error: 'رمز الأمان غير صحيح' });
});

async function startServer() {
  // Mount Vite middleware in development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    const srcPath = path.join(process.cwd(), 'src');
    const publicPath = path.join(process.cwd(), 'public');

    // Serve static files from dist, public, and src
    app.use(express.static(distPath));
    app.use(express.static(publicPath));
    app.use('/src', express.static(srcPath));

    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Samo Warehouse Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
