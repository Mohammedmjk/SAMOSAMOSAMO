import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getDb, saveDbReport, getAllStaffDetailed, getDbReports, upsertStaffUser } from './db.ts';

const DEFAULT_SUPABASE_URL = 'https://boaopqyzhvyzdclmoycr.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_5Tg1o4MnUSseRc1bw78Erg_wIQNF42I';

export const SUPABASE_TABLE_NAME = 'samo';
export const SUPABASE_ORDERS_TABLE_NAME = 'orders';

let supabaseInstance: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabaseInstance) {
    const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;
    supabaseInstance = createClient(url, key, {
      auth: { persistSession: false }
    });
  }
  return supabaseInstance;
}

/**
 * Safely parses any date or locale string (including strings with GMT+0300 or Arabic text)
 * and returns a clean ISO-8601 string acceptable by PostgreSQL / Supabase timestamp columns.
 */
export function formatToIsoDate(val: any, fallback = new Date().toISOString()): string {
  if (!val) return fallback;
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString();
  }
  const str = String(val).trim();
  if (!str) return fallback;

  // Clean strings with parenthesized timezone descriptions like:
  // "Fri Sep 11 2026 00:37:38 GMT+0300 (Arabian Standard Time)"
  // "Wed Feb 02 2028 00:00:00 GMT+0300 (التوقيت العربي الرسمي)"
  const withoutParens = str.replace(/\([^)]*\)/g, '').trim();

  const d1 = new Date(withoutParens);
  if (!isNaN(d1.getTime())) {
    return d1.toISOString();
  }

  const d2 = new Date(str);
  if (!isNaN(d2.getTime())) {
    return d2.toISOString();
  }

  // Handle YYYY-MM-DD or YYYY/MM/DD
  const m = str.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const y = m[1];
    const mo = m[2].padStart(2, '0');
    const d = m[3].padStart(2, '0');
    return `${y}-${mo}-${d}T00:00:00.000Z`;
  }

  return fallback;
}

/**
 * Safely extracts a YYYY-MM-DD date string for PostgreSQL DATE or report_date columns.
 */
export function formatToDateOnly(val: any, fallback = new Date().toISOString().slice(0, 10)): string {
  if (!val) return fallback;
  const str = String(val).trim();
  if (!str) return fallback;

  const m = str.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const y = m[1];
    const mo = m[2].padStart(2, '0');
    const d = m[3].padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }

  const iso = formatToIsoDate(str, '');
  if (iso && /^\d{4}-\d{2}-\d{2}/.test(iso)) {
    return iso.slice(0, 10);
  }

  return fallback;
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

/**
 * Transforms a raw Supabase "samo" row to the application product format
 */
export function samoRowToProduct(row: any) {
  const numVal = (row.number !== undefined && row.number !== null && row.number !== '') ? Number(row.number) : (row.quantity !== undefined && row.quantity !== null && row.quantity !== '' ? Number(row.quantity) : 0);
  const quantity = isNaN(numVal) ? 0 : Math.max(0, numVal);
  const price = Math.max(0, Number(row.price_of_one) || 0);
  const totalPrice = Number(row.total_price) || (quantity * price);
  const minQty = row.limit_number !== null && row.limit_number !== undefined ? Number(row.limit_number) : 5;
  const bonus = Number(row.bonus) || 0;

  let expiryDate = '';
  if (row.expire_date) {
    expiryDate = String(row.expire_date).replace(/\\/g, '-').trim();
  }

  const createdAt = row.created_at || row.createdAt || row.created_date || null;

  return {
    id: String(row.id || ''),
    name: String(row.product || '').trim(),
    barcode: formatBarcode(row.barcode),
    company: row.company ? String(row.company).trim() : '',
    quantity,
    number: quantity,
    minQty,
    price,
    totalPrice,
    bonus,
    expiryDate,
    form: row.category ? String(row.category).trim() : '',
    image: row.image_url || row.image || '',
    createdAt: createdAt || new Date().toISOString(),
    created_at: createdAt || new Date().toISOString()
  };
}

/**
 * Transforms an application product object to the Supabase "samo" table schema
 */
export function productToSamoRow(p: any) {
  const rawNum = p.number !== undefined && p.number !== null ? p.number : p.quantity;
  const quantity = Math.max(0, Number(rawNum) || 0);
  const price = Math.max(0, Number(p.price) || 0);
  const totalPrice = quantity * price;

  let exp = p.expiryDate ? String(p.expiryDate).trim() : null;
  if (exp === '-' || exp === 'غير مسجل') exp = null;

  const createdAt = p.created_at || p.createdAt || new Date().toISOString();

  return {
    id: String(p.id || `PROD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    product: String(p.name || '').trim(),
    barcode: p.barcode ? formatBarcode(p.barcode) : null,
    company: p.company ? String(p.company).trim() : null,
    number: quantity,
    price_of_one: price,
    total_price: totalPrice,
    expire_date: exp,
    bonus: Math.max(0, Number(p.bonus) || 0),
    limit_number: Math.max(0, Number(p.minQty) || 0),
    category: p.form ? String(p.form).trim() : null,
    image_url: p.image || p.imageUrl || p.image_url || null,
    created_at: createdAt
  };
}

/**
 * Fetches all products directly from the Supabase "samo" table
 */
export function fetchAllProductsFromSupabase(): Promise<any[]> {
  const client = getSupabase();
  const pageSize = 1000;
  let from = 0;
  let allRows: any[] = [];
  let hasMore = true;

  return (async () => {
    while (hasMore) {
      const { data, error } = await client
        .from(SUPABASE_TABLE_NAME)
        .select('*')
        .order('created_at', { ascending: false, nullsFirst: false })
        .range(from, from + pageSize - 1);

      if (error) {
        console.error('Supabase fetch error:', error);
        throw new Error(`خطأ في جلب البيانات من Supabase (${error.message})`);
      }

      if (data && data.length > 0) {
        allRows = allRows.concat(data);
        if (data.length < pageSize) {
          hasMore = false;
        } else {
          from += pageSize;
        }
      } else {
        hasMore = false;
      }
    }

    return allRows.map(samoRowToProduct);
  })();
}

/**
 * Inserts a new product into Supabase "samo" table
 */
export async function insertProductToSupabase(product: any): Promise<any> {
  const client = getSupabase();
  const row = productToSamoRow(product);

  const { data, error } = await client
    .from(SUPABASE_TABLE_NAME)
    .insert(row)
    .select()
    .single();

  if (error) {
    console.error('Supabase insert product error:', error);
    throw new Error(`فشل إضافة المادة في Supabase: ${error.message}`);
  }

  return samoRowToProduct(data);
}

/**
 * Updates an existing product in Supabase "samo" table
 */
export async function updateProductInSupabase(product: any): Promise<any> {
  const client = getSupabase();
  const pId = String(product.id || '').trim();
  const pName = String(product.name || '').trim();
  const pBarcode = String(product.barcode || '').trim();

  const price = Math.max(0, Number(product.price) || 0);

  let exp = product.expiryDate ? String(product.expiryDate).trim() : null;
  if (exp === '-' || exp === 'غير مسجل') exp = null;

  const updatePayload: any = {
    price_of_one: price,
    bonus: Math.max(0, Number(product.bonus) || 0),
    limit_number: Math.max(0, Number(product.minQty) || 0)
  };

  const rawNum = product.number !== undefined && product.number !== null ? product.number : product.quantity;
  if (rawNum !== undefined && rawNum !== null && rawNum !== '' && !isNaN(Number(rawNum))) {
    const qty = Math.max(0, Number(rawNum));
    updatePayload.number = qty;
    updatePayload.total_price = qty * price;
  }

  if (pName) updatePayload.product = pName;
  if (product.company !== undefined) updatePayload.company = product.company ? String(product.company).trim() : null;
  if (product.barcode !== undefined) updatePayload.barcode = product.barcode ? formatBarcode(product.barcode) : null;
  if (product.expiryDate !== undefined) updatePayload.expire_date = exp;
  if (product.form !== undefined) updatePayload.category = product.form ? String(product.form).trim() : null;

  let query = client.from(SUPABASE_TABLE_NAME).update(updatePayload);

  if (pId) {
    query = query.eq('id', pId);
  } else if (pBarcode) {
    query = query.eq('barcode', pBarcode);
  } else if (pName) {
    query = query.eq('product', pName);
  } else {
    throw new Error('لا يوجد معرف أو باركود أو اسم للمادة المراد تحديثها');
  }

  const { data, error } = await query.select();
  if (error) {
    console.error('Supabase update error:', error);
    throw new Error(`فشل تحديث المادة في Supabase: ${error.message}`);
  }

  if (data && data.length > 0) {
    return samoRowToProduct(data[0]);
  }
  return null;
}

/**
 * Deletes a product from Supabase "samo" table
 */
export async function deleteProductFromSupabase(id?: string, barcode?: string, name?: string): Promise<boolean> {
  const client = getSupabase();
  let query = client.from(SUPABASE_TABLE_NAME).delete();

  if (id) {
    query = query.eq('id', id);
  } else if (barcode) {
    query = query.eq('barcode', barcode);
  } else if (name) {
    query = query.eq('product', name);
  } else {
    return false;
  }

  const { error } = await query;
  if (error) {
    console.error('Supabase delete error:', error);
    throw new Error(`فشل حذف المادة من Supabase: ${error.message}`);
  }
  return true;
}

/**
 * Deducts stock from Supabase "samo" table for sold / approved order items
 */
export async function deductStockInSupabase(items: Array<{ id?: string; barcode?: string; name?: string; quantity: number }>): Promise<void> {
  const client = getSupabase();

  for (const it of items) {
    const qtyDeduct = Math.max(0, Math.floor(Number(it.quantity) || 0));
    if (qtyDeduct <= 0) continue;

    try {
      // Find row in Supabase
      let prodRow: any = null;
      if (it.id) {
        const { data } = await client.from(SUPABASE_TABLE_NAME).select('*').eq('id', it.id).maybeSingle();
        if (data) prodRow = data;
      }
      if (!prodRow && it.barcode) {
        const { data } = await client.from(SUPABASE_TABLE_NAME).select('*').eq('barcode', it.barcode).maybeSingle();
        if (data) prodRow = data;
      }
      if (!prodRow && it.name) {
        const { data } = await client.from(SUPABASE_TABLE_NAME).select('*').eq('product', it.name).maybeSingle();
        if (data) prodRow = data;
      }

      if (prodRow) {
        const currentQty = Number(prodRow.number) || 0;
        const newQty = Math.max(0, currentQty - qtyDeduct);
        const price = Number(prodRow.price_of_one) || 0;
        const newTotal = newQty * price;

        await client
          .from(SUPABASE_TABLE_NAME)
          .update({
            number: newQty,
            total_price: newTotal
          })
          .eq('id', prodRow.id);
      }
    } catch (err) {
      console.warn(`Could not deduct stock in Supabase for item (${it.name || it.id}):`, err);
    }
  }
}

/**
 * Restores stock in Supabase "samo" table when an item is returned or order canceled
 */
export async function restoreStockInSupabase(itemIdentifier: { id?: string; barcode?: string; name?: string }, qtyToRestore: number): Promise<void> {
  const client = getSupabase();
  const restoreCount = Math.max(0, Math.floor(Number(qtyToRestore) || 0));
  if (restoreCount <= 0) return;

  try {
    let prodRow: any = null;
    if (itemIdentifier.id) {
      const { data } = await client.from(SUPABASE_TABLE_NAME).select('*').eq('id', itemIdentifier.id).maybeSingle();
      if (data) prodRow = data;
    }
    if (!prodRow && itemIdentifier.barcode) {
      const { data } = await client.from(SUPABASE_TABLE_NAME).select('*').eq('barcode', itemIdentifier.barcode).maybeSingle();
      if (data) prodRow = data;
    }
    if (!prodRow && itemIdentifier.name) {
      const { data } = await client.from(SUPABASE_TABLE_NAME).select('*').eq('product', itemIdentifier.name).maybeSingle();
      if (data) prodRow = data;
    }

    if (prodRow) {
      const currentQty = Number(prodRow.number) || 0;
      const newQty = currentQty + restoreCount;
      const price = Number(prodRow.price_of_one) || 0;
      const newTotal = newQty * price;

      await client
        .from(SUPABASE_TABLE_NAME)
        .update({
          number: newQty,
          total_price: newTotal
        })
        .eq('id', prodRow.id);
    }
  } catch (err) {
    console.warn('Could not restore stock in Supabase:', err);
  }
}

/**
 * Returns the connection status and total count of products in Supabase "samo" table
 */
export async function getSupabaseStatus(): Promise<{ connected: boolean; count: number; error?: string; url: string; tableName: string }> {
  const client = getSupabase();
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;

  try {
    const { count, error } = await client
      .from(SUPABASE_TABLE_NAME)
      .select('id', { count: 'exact', head: true });

    if (error) {
      return {
        connected: false,
        count: 0,
        error: error.message,
        url,
        tableName: SUPABASE_TABLE_NAME
      };
    }

    return {
      connected: true,
      count: count || 0,
      url,
      tableName: SUPABASE_TABLE_NAME
    };
  } catch (err: any) {
    return {
      connected: false,
      count: 0,
      error: err.message,
      url,
      tableName: SUPABASE_TABLE_NAME
    };
  }
}

/**
 * Checks table "samo" in Supabase for medicines where stock (number) has fallen below limit_number
 */
export async function fetchLowStockFromSupabase(): Promise<{
  totalCount: number;
  lowStockCount: number;
  outOfStockCount: number;
  items: any[];
}> {
  const allProds = await fetchAllProductsFromSupabase();
  const lowItems = allProds.filter(p => {
    const qty = Number(p.quantity) || 0;
    const min = (p.minQty !== null && p.minQty !== undefined) ? Number(p.minQty) : 5;
    return qty < min;
  });

  const outOfStockCount = lowItems.filter(p => Number(p.quantity) <= 0).length;

  return {
    totalCount: allProds.length,
    lowStockCount: lowItems.length,
    outOfStockCount,
    items: lowItems
  };
}

export const SUPABASE_DRAFTS_TABLE_NAME = 'drafts';
export const SUPABASE_INVENTORY_LOGS_TABLE_NAME = 'inventory_logs';
export const SUPABASE_REPORTS_TABLE_NAME = 'reports';
export const SUPABASE_CUSTOMERS_TABLE_NAME = 'customers';
export const SUPABASE_STAFF_TABLE_NAME = 'staff';

/**
 * Inserts an inventory log entry into the Supabase "inventory_logs" table
 * Actual table columns: action_type (text), item_name (text), details (jsonb), performed_by (text)
 */
export async function insertInventoryLogToSupabase(log: {
  action_type?: string;
  actionType?: string;
  item_name?: string;
  itemName?: string;
  product_name?: string;
  details?: any;
  performed_by?: string;
  performedBy?: string;
  staff_email?: string;
  qty_before?: number;
  qty_change?: number;
  qty_after?: number;
  notes?: string;
}) {
  const client = getSupabase();
  try {
    const pName = log.item_name || log.itemName || log.product_name || 'مادة';
    const email = log.performed_by || log.performedBy || log.staff_email || 'صاحب المذخر';
    const action = log.action_type || log.actionType || 'تعديل رصيد';
    const detailsObj = (typeof log.details === 'object' && log.details !== null)
      ? log.details
      : {
          previous_qty: log.qty_before ?? 0,
          new_qty: log.qty_after ?? (Number(log.qty_before || 0) + Number(log.qty_change || 0)),
          notes: log.notes || ''
        };

    const payload: any = {
      action_type: action,
      item_name: pName,
      details: detailsObj,
      performed_by: email
    };

    const { data, error } = await client
      .from(SUPABASE_INVENTORY_LOGS_TABLE_NAME)
      .insert([payload])
      .select();

    if (error) {
      console.warn('Supabase inventory_logs insert note:', error.message);
      return null;
    }
    return data;
  } catch (err: any) {
    console.warn('Supabase inventory_logs insert exception:', err.message);
    return null;
  }
}

/**
 * Fetches recent inventory logs from Supabase "inventory_logs" table
 */
export async function fetchInventoryLogsFromSupabase(limit = 200) {
  const client = getSupabase();
  try {
    const { data, error } = await client
      .from(SUPABASE_INVENTORY_LOGS_TABLE_NAME)
      .select('*')
      .order('id', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('Supabase inventory_logs fetch note:', error.message);
      return [];
    }
    return data || [];
  } catch (err: any) {
    console.warn('Supabase inventory_logs fetch exception:', err.message);
    return [];
  }
}

/**
 * Saves or updates a daily/periodic sales summary report in Supabase "reports" table
 */
export async function saveReportToSupabase(reportData: {
  report_date: string;
  total_sales: number;
  orders_count?: number;
  pharmacies_count?: number;
  items_count?: number;
  generated_by_email?: string;
  generated_by?: string;
  summary_json?: any;
  summary?: string;
  report_type?: string;
  created_at?: string;
}) {
  const client = getSupabase();
  try {
    const summaryContent = typeof reportData.summary === 'string' && reportData.summary
      ? reportData.summary
      : JSON.stringify({
          ordersCount: Number(reportData.orders_count) || 0,
          pharmaciesCount: Number(reportData.pharmacies_count) || 0,
          itemsCount: Number(reportData.items_count) || 0,
          totalSales: Number(reportData.total_sales) || 0,
          generatedBy: reportData.generated_by || reportData.generated_by_email || '',
          ...(typeof reportData.summary_json === 'object' ? reportData.summary_json : {})
        });

    const repDate = formatToDateOnly(reportData.report_date || reportData.created_at);
    const createdAt = formatToIsoDate(reportData.created_at);

    const payload = {
      report_type: reportData.report_type || 'مبيعات يومية',
      report_date: repDate,
      summary: summaryContent,
      total_sales: Number(reportData.total_sales) || 0,
      generated_by: reportData.generated_by || reportData.generated_by_email || '',
      created_at: createdAt
    };

    const { data, error } = await client
      .from(SUPABASE_REPORTS_TABLE_NAME)
      .insert([payload])
      .select();

    if (error) {
      if (error.message.includes('row-level security') || error.code === '42501') {
        console.info('Supabase reports table RLS policy active; preserving report in local database.');
      } else {
        console.warn('Supabase reports insert note:', error.message);
      }
      try {
        const db = getDb();
        saveDbReport(db, payload);
      } catch {}
      return [payload];
    }
    return data;
  } catch (err: any) {
    console.warn('Supabase reports save exception:', err.message);
    return null;
  }
}

/**
 * Fetches saved reports from Supabase "reports" table
 */
export async function fetchReportsFromSupabase(limit = 50) {
  const client = getSupabase();
  try {
    const { data, error } = await client
      .from(SUPABASE_REPORTS_TABLE_NAME)
      .select('*')
      .order('id', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('Supabase reports fetch note:', error.message);
      return [];
    }

    return (data || []).map((r: any) => {
      let parsedSummary: any = {};
      if (r.summary) {
        try {
          parsedSummary = typeof r.summary === 'object' ? r.summary : JSON.parse(r.summary);
        } catch (e) {
          parsedSummary = { text: r.summary };
        }
      }
      return {
        ...r,
        report_date: r.report_date || (r.created_at ? String(r.created_at).slice(0, 10) : ''),
        total_sales: Number(r.total_sales) || Number(parsedSummary.totalSales) || 0,
        orders_count: Number(parsedSummary.ordersCount || parsedSummary.totalOrders || r.orders_count || 0),
        pharmacies_count: Number(parsedSummary.pharmaciesCount || r.pharmacies_count || 0),
        items_count: Number(parsedSummary.itemsCount || parsedSummary.productsCount || r.items_count || 0),
        generated_by: r.generated_by || r.generated_by_email || parsedSummary.generatedBy || '',
        generated_by_email: r.generated_by || r.generated_by_email || parsedSummary.generatedBy || '',
        summary_json: parsedSummary
      };
    });
  } catch (err: any) {
    console.warn('Supabase reports fetch exception:', err.message);
    return [];
  }
}

/**
 * Fetches customers / pharmacies from Supabase "customers" table
 */
export async function fetchCustomersFromSupabase() {
  const client = getSupabase();
  try {
    const { data, error } = await client
      .from(SUPABASE_CUSTOMERS_TABLE_NAME)
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      console.warn('Supabase customers fetch note:', error.message);
      return [];
    }
    return data || [];
  } catch (err: any) {
    return [];
  }
}

/**
 * Inserts or updates customer in Supabase "customers" table
 * Actual table columns: id, name, phone, address, created_at
 */
export async function insertCustomerToSupabase(c: { id?: string | number; name: string; phone?: string; address?: string; notes?: string }) {
  const client = getSupabase();
  try {
    const payload = {
      name: c.name.trim(),
      phone: c.phone ? c.phone.trim() : null,
      address: c.address ? c.address.trim() : null,
      created_at: new Date().toISOString()
    };
    const { data, error } = await client.from(SUPABASE_CUSTOMERS_TABLE_NAME).insert([payload]).select();
    if (error) {
      console.warn('Supabase customers insert note:', error.message);
      return null;
    }
    return data;
  } catch (err: any) {
    console.warn('Supabase customers insert exception:', err.message);
    return null;
  }
}

/**
 * Fetches staff members from Supabase "staff" table
 */
export async function fetchStaffFromSupabase() {
  const client = getSupabase();
  try {
    const { data, error } = await client
      .from(SUPABASE_STAFF_TABLE_NAME)
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      console.warn('Supabase staff fetch note:', error.message);
      return [];
    }
    return data || [];
  } catch (err: any) {
    return [];
  }
}

/**
 * Inserts staff member into Supabase "staff" table
 */
export async function insertStaffToSupabase(s: { name: string; email?: string; role?: string; assigned_pharmacy?: string; assigned_pharmacy_phone?: string; created_at?: string }) {
  const client = getSupabase();
  try {
    const payload = {
      name: s.name,
      email: s.email || '',
      role: s.role || 'مندوب',
      assigned_pharmacy: s.assigned_pharmacy || '',
      assigned_pharmacy_phone: s.assigned_pharmacy_phone || '',
      created_at: formatToIsoDate(s.created_at)
    };
    const { data, error } = await client.from(SUPABASE_STAFF_TABLE_NAME).insert([payload]).select();
    if (error) {
      if (error.message.includes('row-level security') || error.code === '42501') {
        console.info('Supabase staff table RLS policy active; preserving staff in local database.');
        try {
          const db = getDb();
          db.prepare('INSERT OR IGNORE INTO staff (name, email, role, assigned_pharmacy, assigned_pharmacy_phone, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(s.name, s.email || '', s.role || 'مندوب', s.assigned_pharmacy || '', s.assigned_pharmacy_phone || '', formatToIsoDate(s.created_at));
        } catch {}
        return [payload];
      }
      console.warn('Supabase insertStaff note:', error.message);
      // Retry without new columns if they do not exist yet
      if (error.message.includes('column') || error.message.includes('assigned_pharmacy')) {
        const fallbackPayload = { name: s.name, email: s.email || '', role: s.role || 'مندوب', created_at: formatToIsoDate(s.created_at) };
        const res = await client.from(SUPABASE_STAFF_TABLE_NAME).insert([fallbackPayload]).select();
        return res.data;
      }
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Updates staff member (e.g. assigned_pharmacy, role, email) in Supabase "staff" table
 */
export async function updateStaffInSupabase(name: string, updates: { assigned_pharmacy?: string; assigned_pharmacy_phone?: string; email?: string; role?: string }) {
  const client = getSupabase();
  try {
    const payload: any = {
      ...updates,
      updated_at: new Date().toISOString()
    };
    const { data, error } = await client
      .from(SUPABASE_STAFF_TABLE_NAME)
      .update(payload)
      .or(`name.eq."${name}",email.eq."${name}"`)
      .select();

    if (error) {
      if (error.message.includes('row-level security') || error.code === '42501') {
        console.info('Supabase staff update note: table has RLS policy enabled.');
      } else {
        console.warn('Supabase updateStaff error, trying eq name:', error.message);
      }
      const fallbackRes = await client.from(SUPABASE_STAFF_TABLE_NAME).update(payload).eq('name', name).select();
      return fallbackRes.data;
    }
    return data;
  } catch (err: any) {
    console.warn('Supabase updateStaff exception:', err.message);
    return null;
  }
}

/**
 * Upserts a Google account or staff member into Supabase "staff" table
 */
export async function upsertStaffInSupabase(user: { name?: string; email: string; role?: string; assigned_pharmacy?: string; assigned_pharmacy_phone?: string }) {
  const client = getSupabase();
  const cleanEmail = String(user.email || '').trim().toLowerCase();
  const cleanName = String(user.name || (cleanEmail ? cleanEmail.split('@')[0] : 'موظف')).trim();
  if (!cleanEmail && !cleanName) return null;

  try {
    // 1. Check if user already exists by email first, or by name
    let existing: any = null;
    let duplicateIds: any[] = [];

    if (cleanEmail) {
      const { data: byEmail } = await client.from(SUPABASE_STAFF_TABLE_NAME).select('*').ilike('email', cleanEmail);
      if (Array.isArray(byEmail) && byEmail.length > 0) {
        existing = byEmail[0];
        if (byEmail.length > 1) {
          duplicateIds = byEmail.slice(1).map(r => r.id).filter(Boolean);
        }
      }
    }

    if (!existing && cleanName) {
      const { data: byName } = await client.from(SUPABASE_STAFF_TABLE_NAME).select('*').ilike('name', cleanName);
      if (Array.isArray(byName) && byName.length > 0) {
        existing = byName[0];
      }
    }

    if (existing) {
      const updates: any = {};
      if (cleanEmail && existing.email !== cleanEmail) updates.email = cleanEmail;
      if (cleanName && cleanName !== 'موظف' && !cleanName.includes('@') && existing.name !== cleanName) updates.name = cleanName;
      if (user.role && existing.role !== user.role) updates.role = user.role;
      if (user.assigned_pharmacy !== undefined) {
        updates.assigned_pharmacy = user.assigned_pharmacy;
        updates.assigned_pharmacy_phone = user.assigned_pharmacy_phone || '';
      }

      let resultRecord = existing;
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        const { data: updated } = await client.from(SUPABASE_STAFF_TABLE_NAME).update(updates).eq('id', existing.id || existing.name).select();
        resultRecord = updated?.[0] || { ...existing, ...updates };
      }

      // Cleanup duplicate records with same email if any
      if (duplicateIds.length > 0) {
        try {
          await client.from(SUPABASE_STAFF_TABLE_NAME).delete().in('id', duplicateIds);
        } catch (e) {
          console.warn('Supabase cleanup duplicate staff note:', e);
        }
      }

      return resultRecord;
    }

    // 2. Insert new user
    const insertPayload: any = {
      name: cleanName,
      email: cleanEmail,
      role: user.role || 'مندوب',
      assigned_pharmacy: user.assigned_pharmacy || '',
      assigned_pharmacy_phone: user.assigned_pharmacy_phone || '',
      created_at: formatToIsoDate(new Date().toISOString())
    };

    const { data, error } = await client.from(SUPABASE_STAFF_TABLE_NAME).insert([insertPayload]).select();
    if (error) {
      if (error.message.includes('row-level security') || error.code === '42501') {
        console.info('Supabase staff table RLS policy active; preserving staff upsert in local database.');
        try {
          const db = getDb();
          upsertStaffUser(db, {
            name: cleanName,
            email: cleanEmail,
            role: user.role || 'مندوب',
            assignedPharmacy: user.assigned_pharmacy,
            pharmacyPhone: user.assigned_pharmacy_phone
          });
        } catch {}
        return insertPayload;
      }
      console.warn('Supabase upsertStaff insert note:', error.message);
      if (error.message.includes('column') || error.message.includes('assigned_pharmacy')) {
        const simple = { name: cleanName, email: cleanEmail, role: user.role || 'مندوب', created_at: formatToIsoDate(new Date().toISOString()) };
        const res = await client.from(SUPABASE_STAFF_TABLE_NAME).insert([simple]).select();
        return res.data?.[0];
      }
      return null;
    }
    return data?.[0] || insertPayload;
  } catch (err: any) {
    console.warn('Supabase upsertStaff exception:', err.message);
    return null;
  }
}

/**
 * Inserts a batch of staff members into Supabase "staff" table
 */
export async function insertStaffBatchToSupabase(staffList: any[]) {
  if (!Array.isArray(staffList) || staffList.length === 0) return [];
  const client = getSupabase();
  try {
    const payload = staffList.map(s => {
      const name = typeof s === 'object' ? String(s.name || '').trim() : String(s || '').trim();
      const email = typeof s === 'object' ? String(s.email || '').trim().toLowerCase() : '';
      const role = typeof s === 'object' ? (s.role || 'مندوب مبيعات') : 'مندوب مبيعات';
      const rawCreatedAt = (typeof s === 'object' && s.created_at) ? s.created_at : new Date().toISOString();
      return {
        name,
        email,
        role,
        created_at: formatToIsoDate(rawCreatedAt)
      };
    }).filter(s => s.name);

    if (payload.length === 0) return [];

    // Always preserve in local SQLite database first
    try {
      const db = getDb();
      for (const st of payload) {
        db.prepare('INSERT OR IGNORE INTO staff (name, email, role, created_at) VALUES (?, ?, ?, ?)').run(st.name, st.email, st.role, st.created_at);
      }
    } catch (dbErr) {
      console.warn('Local staff batch preserve note:', dbErr);
    }

    const { data, error } = await client.from(SUPABASE_STAFF_TABLE_NAME).insert(payload).select();
    if (error) {
      if (error.message.includes('row-level security') || error.code === '42501') {
        console.info('Supabase staff table RLS policy active; staff batch safely stored in local database.');
      } else {
        console.info('Supabase staff table sync status:', error.message);
      }
      return payload;
    }
    return data || payload;
  } catch (err: any) {
    console.info('Supabase insertStaffBatch status:', err.message);
    return [];
  }
}

/**
 * Deletes staff member from Supabase "staff" table by name or id
 */
export async function deleteStaffFromSupabase(nameOrId: string | number): Promise<boolean> {
  const client = getSupabase();
  try {
    let query = client.from(SUPABASE_STAFF_TABLE_NAME).delete();
    if (typeof nameOrId === 'number' || !isNaN(Number(nameOrId))) {
      query = query.eq('id', Number(nameOrId));
    } else {
      query = query.eq('name', String(nameOrId));
    }
    const { error } = await query;
    if (error) {
      console.warn('Supabase deleteStaff error:', error.message);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn('Supabase deleteStaff exception:', err.message);
    return false;
  }
}

/**
 * Inserts a batch of reports into Supabase "reports" table
 */
export async function insertReportsBatchToSupabase(reportsList: any[]) {
  if (!Array.isArray(reportsList) || reportsList.length === 0) return [];
  const client = getSupabase();
  try {
    const payload = reportsList.map(r => {
      const summaryContent = typeof r.summary === 'string' && r.summary
        ? r.summary
        : JSON.stringify({
            ordersCount: Number(r.orders_count || r.ordersCount || 0),
            pharmaciesCount: Number(r.pharmacies_count || r.pharmaciesCount || 0),
            itemsCount: Number(r.items_count || r.itemsCount || 0),
            totalSales: Number(r.total_sales || r.totalDispatched || 0),
            generatedBy: r.generated_by || r.generated_by_email || r.staffEmail || '',
            ...(typeof r.summary_json === 'object' ? r.summary_json : (typeof r.summary_json === 'string' ? JSON.parse(r.summary_json || '{}') : {}))
          });

      const repDate = formatToDateOnly(r.report_date || r.created_at);
      const createdAt = formatToIsoDate(r.created_at);

      return {
        report_type: r.report_type || r.type || 'مبيعات يومية',
        report_date: repDate,
        summary: summaryContent,
        total_sales: Number(r.total_sales || r.totalDispatched || 0),
        generated_by: r.generated_by || r.generated_by_email || r.staffEmail || '',
        created_at: createdAt
      };
    });

    if (payload.length === 0) return [];

    // Always preserve in local SQLite reports table first
    try {
      const db = getDb();
      for (const rep of payload) {
        saveDbReport(db, rep);
      }
    } catch (dbErr) {
      console.warn('Local reports batch preserve note:', dbErr);
    }

    const { data, error } = await client.from(SUPABASE_REPORTS_TABLE_NAME).insert(payload).select();
    if (error) {
      if (error.message.includes('row-level security') || error.code === '42501') {
        console.info('Supabase reports table RLS policy active; reports safely stored in local database.');
      } else {
        console.info('Supabase reports table sync status:', error.message);
      }
      return payload;
    }
    return data || payload;
  } catch (err: any) {
    console.info('Supabase insertReportsBatch status:', err.message);
    return [];
  }
}

/**
 * One-time check and migration function for staff and reports:
 * If table "staff" is empty (0 rows), inserts currentStaffList.
 * If table "reports" is empty (0 rows), inserts currentReportsList.
 */
export async function migrateStaffAndReportsIfEmpty(currentStaffList: any[], currentReportsList: any[]) {
  const client = getSupabase();
  const db = getDb();
  const results = {
    staffMigrated: false,
    staffCount: 0,
    reportsMigrated: false,
    reportsCount: 0,
    errors: [] as string[]
  };

  try {
    // 1. Check staff table in Supabase
    const { data: existingStaff, error: staffErr } = await client
      .from(SUPABASE_STAFF_TABLE_NAME)
      .select('*');

    if (staffErr) {
      results.errors.push(`Staff check note: ${staffErr.message}`);
    } else if (!existingStaff || existingStaff.length === 0) {
      if (Array.isArray(currentStaffList) && currentStaffList.length > 0) {
        const insertedStaff = await insertStaffBatchToSupabase(currentStaffList);
        results.staffMigrated = insertedStaff.length > 0;
        results.staffCount = insertedStaff.length;
      }
    } else {
      results.staffCount = existingStaff.length;
    }

    // 2. Check reports table in Supabase
    const { data: existingReports, error: repErr } = await client
      .from(SUPABASE_REPORTS_TABLE_NAME)
      .select('*');

    if (repErr) {
      results.errors.push(`Reports check note: ${repErr.message}`);
    } else if (!existingReports || existingReports.length === 0) {
      if (Array.isArray(currentReportsList) && currentReportsList.length > 0) {
        const insertedReports = await insertReportsBatchToSupabase(currentReportsList);
        results.reportsMigrated = insertedReports.length > 0;
        results.reportsCount = insertedReports.length;
      }
    } else {
      results.reportsCount = existingReports.length;
    }

    // Ensure staffCount and reportsCount reflect persistent state
    if (results.staffCount === 0) {
      results.staffCount = getAllStaffDetailed(db).length;
    }
    if (results.reportsCount === 0) {
      results.reportsCount = getDbReports(db, 50).length;
    }
  } catch (err: any) {
    results.errors.push(`Migration exception: ${err.message}`);
  }

  return results;
}

/**
 * Inserts an order row into the Supabase "orders" table with optional staff_email
 */
export async function insertOrderToSupabase(orderData: {
  id?: string;
  checkout_id?: string;
  customer_id?: number | null;
  customer_name: string;
  items: any[];
  total_amount: number;
  status?: string;
  staff_email?: string;
  notes?: string;
}) {
  const client = getSupabase();
  const payload: any = {
    customer_name: orderData.customer_name,
    items: orderData.items,
    total_amount: orderData.total_amount,
    status: orderData.status || 'قيد المراجعة',
    created_at: new Date().toISOString()
  };

  if (orderData.id) {
    payload.id = orderData.id;
  }
  if (orderData.checkout_id) {
    payload.checkout_id = orderData.checkout_id;
  }
  if (orderData.customer_id !== undefined && orderData.customer_id !== null) {
    payload.customer_id = orderData.customer_id;
  }
  if (orderData.staff_email) {
    payload.staff_email = orderData.staff_email;
  }
  if (orderData.notes) {
    payload.notes = orderData.notes;
  }

  // ONE CHECKOUT = ONE ORDER: if checkout_id is present, check existing or upsert with onConflict 'checkout_id'
  if (orderData.checkout_id) {
    try {
      const { data: existing } = await client
        .from(SUPABASE_ORDERS_TABLE_NAME)
        .select('*')
        .eq('checkout_id', orderData.checkout_id)
        .maybeSingle();

      if (existing) {
        console.log(`[insertOrderToSupabase] Reusing existing Supabase order for checkout_id: ${orderData.checkout_id}`);
        return [existing];
      }
    } catch (chkLookupErr) {
      console.warn('checkout_id check error in Supabase:', chkLookupErr);
    }

    const { data: upsertData, error: upsertErr } = await client
      .from(SUPABASE_ORDERS_TABLE_NAME)
      .upsert([payload], { onConflict: 'checkout_id' })
      .select();

    if (!upsertErr && upsertData && upsertData.length > 0) return upsertData;

    if (upsertErr) {
      console.warn('Supabase orders upsert with checkout_id note:', upsertErr.message);
      // If error is duplicate key on checkout_id, fetch and return the existing order
      if (upsertErr.code === '23505' || upsertErr.message.includes('unique') || upsertErr.message.includes('duplicate')) {
        const { data: dupExisting } = await client
          .from(SUPABASE_ORDERS_TABLE_NAME)
          .select('*')
          .eq('checkout_id', orderData.checkout_id)
          .maybeSingle();
        if (dupExisting) return [dupExisting];
      }
      throw new Error(upsertErr.message);
    }
    return upsertData || [];
  }

  const { data, error } = await client
    .from(SUPABASE_ORDERS_TABLE_NAME)
    .insert([payload])
    .select();

  if (error) {
    console.error('Supabase orders insert error:', error);
    // If column staff_email doesn't exist yet, retry without staff_email as fallback
    if (orderData.staff_email && (error.message.includes('staff_email') || error.message.includes('column'))) {
      delete payload.staff_email;
      const retryRes = await client.from(SUPABASE_ORDERS_TABLE_NAME).insert([payload]).select();
      if (!retryRes.error) return retryRes.data;
    }
    throw new Error(error.message);
  }
  return data;
}

/**
 * Fetches orders from the Supabase "orders" table (optionally filtered by staff_email)
 */
export async function fetchAllOrdersFromSupabase(staffEmail?: string): Promise<any[]> {
  const client = getSupabase();
  try {
    let query = client
      .from(SUPABASE_ORDERS_TABLE_NAME)
      .select('*');

    if (staffEmail && String(staffEmail).trim() !== '') {
      query = query.eq('staff_email', String(staffEmail).trim());
    }

    const { data, error } = await query.order('id', { ascending: false });

    if (error) {
      console.warn('Supabase orders fetch note:', error.message);
      // If error is about missing staff_email column in Supabase, retry without filter
      if (staffEmail && (error.message.includes('staff_email') || error.message.includes('column'))) {
        const retryRes = await client.from(SUPABASE_ORDERS_TABLE_NAME).select('*').order('id', { ascending: false });
        if (!retryRes.error && Array.isArray(retryRes.data)) {
          return retryRes.data;
        }
      }
      return [];
    }
    return data || [];
  } catch (err: any) {
    console.warn('Supabase fetchAllOrdersFromSupabase exception:', err.message);
    return [];
  }
}

/**
 * Updates order status in the Supabase "orders" table
 */
export async function updateOrderStatusInSupabase(
  orderNumber: string | number,
  newStatus: string,
  approvedBy?: string
): Promise<void> {
  const client = getSupabase();
  try {
    const updateData: any = { status: newStatus };
    if (approvedBy) {
      updateData.approved_by = approvedBy;
      updateData.approved_at = new Date().toISOString();
    }

    const strVal = String(orderNumber).trim();
    let numId = Number(strVal);
    if (isNaN(numId)) {
      const match = strVal.match(/ORD-SB-(\d+)/);
      if (match) numId = Number(match[1]);
    }

    let query = client.from(SUPABASE_ORDERS_TABLE_NAME).update(updateData);
    if (!isNaN(numId) && numId > 0) {
      query = query.eq('id', numId);
    } else {
      query = query.eq('id', strVal);
    }

    const { error } = await query;
    if (error) {
      console.warn('Supabase updateOrderStatus note, attempting fallback with status only:', error.message);
      delete updateData.approved_by;
      delete updateData.approved_at;
      let fbQuery = client.from(SUPABASE_ORDERS_TABLE_NAME).update(updateData);
      if (!isNaN(numId) && numId > 0) {
        fbQuery = fbQuery.eq('id', numId);
      } else {
        fbQuery = fbQuery.eq('id', strVal);
      }
      await fbQuery;
    }
  } catch (err: any) {
    console.warn('Supabase updateOrderStatus note:', err.message);
  }
}

/**
 * Uploads a medicine / product image to Supabase Storage in the "products" bucket
 * and returns the public URL.
 */
export async function uploadProductImageToSupabaseStorage(
  fileName: string,
  base64Data: string,
  contentType = 'image/jpeg'
): Promise<{ success: boolean; publicUrl: string; error?: string }> {
  const client = getSupabase();
  try {
    const cleanBase64 = base64Data.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    const safeName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = `products/${safeName}`;

    // Upload to 'products' bucket in Supabase Storage
    const { data, error } = await client.storage
      .from('products')
      .upload(filePath, buffer, {
        contentType,
        upsert: true
      });

    if (error) {
      console.warn('Supabase storage upload note:', error.message);
      // If bucket doesn't exist yet, return error clearly
      return { success: false, publicUrl: '', error: error.message };
    }

    const { data: publicData } = client.storage
      .from('products')
      .getPublicUrl(filePath);

    return {
      success: true,
      publicUrl: publicData.publicUrl
    };
  } catch (err: any) {
    console.error('uploadProductImageToSupabaseStorage error:', err);
    return { success: false, publicUrl: '', error: err.message };
  }
}

/**
 * Deletes an order from the Supabase "orders" table (only when user clicks delete)
 */
export async function deleteOrderFromSupabase(idOrOrderNumber: string | number, checkoutId?: string): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;
  const idStr = String(idOrOrderNumber || '').trim();
  const chk = checkoutId ? String(checkoutId).trim() : '';
  if (!idStr && !chk) return false;

  try {
    let deleted = false;
    // 1. Delete by checkout_id if provided
    if (chk) {
      try {
        const { error: chkErr } = await client.from(SUPABASE_ORDERS_TABLE_NAME).delete().eq('checkout_id', chk);
        if (!chkErr) deleted = true;
      } catch (e) {}
    }

    // 2. Delete by exact id / order number
    if (idStr) {
      const numId = Number(idStr);
      if (!isNaN(numId) && numId > 0 && String(numId) === idStr) {
        const { error } = await client.from(SUPABASE_ORDERS_TABLE_NAME).delete().eq('id', numId);
        if (!error) deleted = true;
      } else {
        const match = idStr.match(/ORD-SB-(\d+)/);
        if (match) {
          const parsedNum = Number(match[1]);
          if (!isNaN(parsedNum) && parsedNum > 0) {
            const { error: numErr } = await client.from(SUPABASE_ORDERS_TABLE_NAME).delete().eq('id', parsedNum);
            if (!numErr) deleted = true;
          }
        }
        const { error: strErr } = await client.from(SUPABASE_ORDERS_TABLE_NAME).delete().eq('id', idStr);
        if (!strErr) deleted = true;

        // Try deleting if idStr was passed as checkout_id
        try {
          await client.from(SUPABASE_ORDERS_TABLE_NAME).delete().eq('checkout_id', idStr);
        } catch (e) {}
      }
    }

    return true;
  } catch (err: any) {
    console.warn('Supabase deleteOrder exception:', err.message);
    return false;
  }
}

/**
 * Deletes a customer from Supabase "customers" table
 */
export async function deleteCustomerFromSupabase(id?: string | number, name?: string): Promise<boolean> {
  const client = getSupabase();
  try {
    let query = client.from(SUPABASE_CUSTOMERS_TABLE_NAME).delete();
    if (id) {
      const numId = Number(id);
      if (!isNaN(numId) && !String(id).startsWith('ph_')) {
        query = query.eq('id', numId);
      } else {
        query = query.eq('id', id);
      }
    } else if (name) {
      query = query.eq('name', name);
    } else {
      return false;
    }

    const { error } = await query;
    if (error) {
      console.warn('Supabase deleteCustomer error:', error.message);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn('Supabase deleteCustomer exception:', err.message);
    return false;
  }
}

/**
 * Saves staff draft invoice to Supabase "drafts" table
 */
export async function saveDraftToSupabase(staffEmail: string, draftData: any) {
  if (!staffEmail) return null;
  const client = getSupabase();
  try {
    const { data, error } = await client
      .from(SUPABASE_DRAFTS_TABLE_NAME)
      .upsert({
        staff_email: staffEmail,
        draft_data: draftData,
        updated_at: new Date().toISOString()
      }, { onConflict: 'staff_email' })
      .select();

    if (error) {
      console.warn('Supabase draft upsert warning (may need table creation):', error.message);
      return null;
    }
    return data;
  } catch (err: any) {
    console.warn('Supabase draft save exception:', err.message);
    return null;
  }
}

/**
 * Fetches staff draft invoice from Supabase "drafts" table
 */
export async function fetchDraftFromSupabase(staffEmail: string) {
  if (!staffEmail) return null;
  const client = getSupabase();
  try {
    const { data, error } = await client
      .from(SUPABASE_DRAFTS_TABLE_NAME)
      .select('*')
      .eq('staff_email', staffEmail)
      .single();

    if (error) {
      return null;
    }
    return data;
  } catch (err: any) {
    return null;
  }
}

/**
 * Deletes staff draft invoice from Supabase "drafts" table
 */
export async function deleteDraftFromSupabase(staffEmail: string) {
  if (!staffEmail) return;
  const client = getSupabase();
  try {
    await client
      .from(SUPABASE_DRAFTS_TABLE_NAME)
      .delete()
      .eq('staff_email', staffEmail);
  } catch (err: any) {
    console.warn('Supabase draft delete note:', err.message);
  }
}


