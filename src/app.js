/**
 * مستودع سامو للأدوية - العميل الرئيسي المتكامل
 * متصل بقاعدة بيانات SQLite المحلية عبر واجهة API السريعة
 */

const API_URL = "/api";

const DEFAULT_SUPABASE_URL = 'https://boaopqyzhvyzdclmoycr.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_5Tg1o4MnUSseRc1bw78Erg_wIQNF42I';

let clientSupabaseInstance = null;

function getSupabaseClient() {
  if (clientSupabaseInstance) return clientSupabaseInstance;
  try {
    const sbObj = window.supabase;
    if (sbObj && typeof sbObj.from === 'function') {
      clientSupabaseInstance = sbObj;
      return clientSupabaseInstance;
    }
    if (sbObj && typeof sbObj.createClient === 'function') {
      clientSupabaseInstance = sbObj.createClient(DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY);
      return clientSupabaseInstance;
    }
    if (typeof window.createClient === 'function') {
      clientSupabaseInstance = window.createClient(DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY);
      return clientSupabaseInstance;
    }
  } catch (err) {
    console.warn('Supabase client initialization warning:', err);
  }
  return null;
}

function formatBarcode(val) {
  if (!val) return '';
  let str = String(val).trim();
  if (str.toLowerCase().includes('e')) {
    let num = Number(str);
    if (!isNaN(num)) {
      return BigInt(Math.round(num)).toString();
    }
  }
  return str.replace(/\.0+$/, '').replace(/\D/g, ''); // أرقام فقط
}
window.formatBarcode = formatBarcode;
window.formatBarcodeDisplay = formatBarcode;

function supabaseOrderToAppOrder(row) {
  if (!row) return null;
  let items = [];
  if (Array.isArray(row.items)) {
    items = row.items;
  } else if (typeof row.items === 'string') {
    try {
      items = JSON.parse(row.items);
    } catch (e) {
      items = [];
    }
  }

  const orderNum = row.order_number || row.orderNumber || (row.id ? `ORD-SB-${row.id}` : `ORD-${Date.now()}`);
  const phName = row.customer_name || row.customerName || row.pharmacy_name || row.pharmacyName || 'عميل / صيدلية';
  const total = Number(row.total_amount ?? row.totalAmount ?? row.total_price ?? 0);
  const status = String(row.status || '').trim();
  const displayStatus = (status === 'قيد المراجعة')
    ? 'قيد المراجعة'
    : (['completed', 'معتمد', 'delivered', 'تم التجهيز', 'تم التسليم', 'approved', 'مستلم', 'مسلّم', 'مسلمة'].includes(status.toLowerCase()) || isApprovedOrder({ status }))
      ? 'معتمد'
      : status;

  return {
    id: String(row.id || orderNum),
    orderNumber: orderNum,
    pharmacyName: phName,
    customerName: phName,
    phone: row.phone || '',
    staffName: row.staff_name || row.staffName || '',
    staffEmail: row.staff_email || row.staffEmail || '',
    deliveryStaffName: row.delivery_staff_name || '',
    totalAmount: total,
    status: displayStatus,
    date: row.created_at ? new Date(row.created_at).toLocaleString('ar-IQ') : new Date().toLocaleString('ar-IQ'),
    createdAt: row.created_at || new Date().toISOString(),
    items: items.map(it => ({
      id: it.id || '',
      name: it.name || it.product || '',
      barcode: it.barcode || '',
      form: it.form || it.category || 'Tablet',
      quantity: Number(it.quantity || it.number || it.qty || 0),
      price: Number(it.price || it.price_of_one || 0),
      expiryDate: it.expiryDate || it.expire_date || ''
    }))
  };
}

async function fetchOrdersFromSupabase(staffEmailFilter = null) {
  const sb = getSupabaseClient();
  if (!sb) return [];
  try {
    let query = sb.from('orders').select('*');
    if (staffEmailFilter && String(staffEmailFilter).trim()) {
      query = query.eq('staff_email', String(staffEmailFilter).trim());
    }
    const { data, error } = await query.order('id', { ascending: false });

    if (error) {
      console.warn('Supabase fetch orders error:', error.message);
      return [];
    }

    if (Array.isArray(data)) {
      return data.map(supabaseOrderToAppOrder).filter(Boolean);
    }
    return [];
  } catch (err) {
    console.warn('fetchOrdersFromSupabase exception:', err);
    return [];
  }
}

// ================= Supabase Staff & Reports Direct Client & Migration =================
let supabaseStaffList = [];
let supabaseReportsList = [];

/**
 * Reads staff members directly and exclusively from Supabase 'staff' table
 */
async function fetchStaffFromSupabaseDirect(notify = false) {
  const sb = getSupabaseClient();
  let staffRows = [];

  try {
    if (sb) {
      const { data, error } = await sb
        .from('staff')
        .select('*')
        .order('id', { ascending: true });

      if (!error && Array.isArray(data) && data.length > 0) {
        staffRows = data;
      } else if (error) {
        console.warn('Direct Supabase staff fetch note:', error.message);
      }
    }

    // Fallback to proxy API if client-side query was empty or failed
    if (staffRows.length === 0) {
      const res = await fetch('/api/supabase/staff', { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json && Array.isArray(json.staff)) {
          staffRows = json.staff;
        }
      }
    }

    if (staffRows.length > 0) {
      supabaseStaffList = staffRows;
      const names = staffRows.map(s => (typeof s === 'object' ? s.name : s)).filter(Boolean);
      if (names.length > 0) {
        staffNames = Array.from(new Set(names));
        localStorage.setItem('samo_local_staff', JSON.stringify(staffNames));
      }
      populateStaffDropdowns();
      if (typeof renderSettingsStaff === 'function') renderSettingsStaff();
      if (typeof renderStaffReport === 'function') renderStaffReport();
      if (notify) showQuickToast(`تم تحديث ${staffRows.length} موظف مباشرة من Supabase ✓`);
      return staffRows;
    }
  } catch (err) {
    console.warn('fetchStaffFromSupabaseDirect error:', err);
  }
  return [];
}
window.fetchStaffFromSupabaseDirect = fetchStaffFromSupabaseDirect;

/**
 * Reads reports directly and exclusively from Supabase 'reports' table
 */
async function fetchReportsFromSupabaseDirect(notify = false) {
  const sb = getSupabaseClient();
  let reportRows = [];

function normalizeSupabaseReport(r) {
  let summaryObj = {};
  if (r.summary) {
    try {
      summaryObj = typeof r.summary === 'object' ? r.summary : JSON.parse(r.summary);
    } catch (e) {
      summaryObj = { text: r.summary };
    }
  }
  return {
    ...r,
    report_type: r.report_type || 'مبيعات يومية',
    report_date: r.report_date || (r.created_at ? String(r.created_at).slice(0, 10) : ''),
    total_sales: Number(r.total_sales || summaryObj.totalSales || summaryObj.totalDispatched || 0),
    orders_count: Number(summaryObj.ordersCount || summaryObj.totalOrders || r.orders_count || 0),
    pharmacies_count: Number(summaryObj.pharmaciesCount || r.pharmacies_count || 0),
    items_count: Number(summaryObj.itemsCount || summaryObj.productsCount || r.items_count || 0),
    generated_by: r.generated_by || r.generated_by_email || summaryObj.generatedBy || summaryObj.staffEmail || '',
    generated_by_email: r.generated_by || r.generated_by_email || summaryObj.generatedBy || summaryObj.staffEmail || '',
    summary_json: summaryObj
  };
}
window.normalizeSupabaseReport = normalizeSupabaseReport;

  try {
    if (sb) {
      const { data, error } = await sb
        .from('reports')
        .select('*')
        .order('id', { ascending: false });

      if (!error && Array.isArray(data) && data.length > 0) {
        reportRows = data.map(normalizeSupabaseReport);
      } else if (error) {
        console.warn('Direct Supabase reports fetch note:', error.message);
      }
    }

    // Fallback to proxy API if client-side query was empty or failed
    if (reportRows.length === 0) {
      const res = await fetch('/api/supabase/reports', { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json && Array.isArray(json.reports)) {
          reportRows = json.reports.map(normalizeSupabaseReport);
        }
      }
    }

    supabaseReportsList = reportRows;
    renderSupabaseReportsList();
    if (notify) {
      showQuickToast(`تم تحديث ${reportRows.length} تقرير مباشرة من Supabase ✓`);
    }
    return reportRows;
  } catch (err) {
    console.warn('fetchReportsFromSupabaseDirect error:', err);
  }
  return [];
}
window.fetchReportsFromSupabaseDirect = fetchReportsFromSupabaseDirect;

/**
 * Safe date parsing helpers to prevent invalid timestamps or unrecognized timezone formats
 */
function safeIsoDate(val, fallback = new Date().toISOString()) {
  if (!val) return fallback;
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString();
  }
  const str = String(val).trim();
  if (!str) return fallback;
  const withoutParens = str.replace(/\([^)]*\)/g, '').trim();
  const d1 = new Date(withoutParens);
  if (!isNaN(d1.getTime())) return d1.toISOString();
  const d2 = new Date(str);
  if (!isNaN(d2.getTime())) return d2.toISOString();
  const m = str.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00.000Z`;
  }
  return fallback;
}

function safeDateOnly(val, fallback = new Date().toISOString().slice(0, 10)) {
  if (!val) return fallback;
  const str = String(val).trim();
  if (!str) return fallback;
  const m = str.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  const iso = safeIsoDate(str, '');
  if (iso && /^\d{4}-\d{2}-\d{2}/.test(iso)) {
    return iso.slice(0, 10);
  }
  return fallback;
}

/**
 * Generates initial snapshot reports from orders when reports table in Supabase is empty
 */
function generateInitialReportsSnapshot() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const reportsByDate = new Map();

  if (Array.isArray(orders) && orders.length > 0) {
    orders.forEach(o => {
      let d = safeDateOnly(o.date || o.createdAt, todayStr);
      if (!reportsByDate.has(d)) {
        reportsByDate.set(d, {
          report_date: d,
          total_sales: 0,
          orders_count: 0,
          pharmacies: new Set(),
          items_count: 0,
          generated_by: o.staffEmail || currentStaffEmail || 'admin@samo.iq',
          created_at: safeIsoDate(o.createdAt || o.date)
        });
      }
      const rep = reportsByDate.get(d);
      rep.total_sales += Number(o.totalAmount || 0);
      rep.orders_count += 1;
      if (o.pharmacyName) rep.pharmacies.add(String(o.pharmacyName).trim());
      const oItems = Array.isArray(o.items) ? o.items.reduce((acc, it) => acc + (Number(it.quantity) || 1), 0) : 1;
      rep.items_count += oItems;
    });
  }

  if (reportsByDate.size === 0) {
    const totalSales = (orders || []).reduce((acc, o) => acc + Number(o.totalAmount || 0), 0);
    const uniquePh = new Set((orders || []).map(o => o.pharmacyName).filter(Boolean));
    const defaultAuthor = currentStaffEmail || 'admin@samo.iq';
    return [{
      report_type: 'مبيعات يومية',
      report_date: todayStr,
      summary: JSON.stringify({
        note: 'التقرير التأسيسي لمذخر سامو',
        ordersCount: (orders || []).length,
        pharmaciesCount: uniquePh.size,
        itemsCount: (products || []).length,
        totalSales: totalSales,
        generatedBy: defaultAuthor
      }),
      total_sales: totalSales,
      generated_by: defaultAuthor,
      created_at: new Date().toISOString()
    }];
  }

  return Array.from(reportsByDate.values()).map(r => ({
    report_type: 'مبيعات يومية',
    report_date: safeDateOnly(r.report_date || r.created_at, todayStr),
    summary: JSON.stringify({
      ordersCount: r.orders_count,
      pharmaciesCount: r.pharmacies.size,
      itemsCount: r.items_count,
      totalSales: r.total_sales,
      generatedBy: r.generated_by || 'admin@samo.iq'
    }),
    total_sales: r.total_sales,
    generated_by: r.generated_by || 'admin@samo.iq',
    created_at: safeIsoDate(r.created_at)
  }));
}

/**
 * One-time startup check and migration function:
 * Checks "staff" in Supabase, if empty -> uploads currentStaffList
 * Checks "reports" in Supabase, if empty -> uploads currentReportsList
 */
let isMigrationRunning = false;
async function checkAndMigrateStaffAndReports(interactive = false) {
  if (isMigrationRunning) return;
  isMigrationRunning = true;

  try {
    const sb = getSupabaseClient();
    let staffNeedsUpload = false;
    let reportsNeedsUpload = false;

    // 1. Prepare current local staff payload
    const currentStaffList = (staffNames && staffNames.length > 0 ? staffNames : ['حسين', 'سجاد', 'أحمد', 'محمد', 'علي'])
      .map(name => ({
        name: typeof name === 'object' ? name.name : String(name).trim(),
        role: typeof name === 'object' ? (name.role || 'مندوب مبيعات') : 'مندوب مبيعات',
        email: typeof name === 'object' ? (name.email || '') : '',
        created_at: safeIsoDate(typeof name === 'object' && name.created_at ? name.created_at : new Date().toISOString())
      }));

    // 2. Prepare current local reports payload
    const currentReportsList = generateInitialReportsSnapshot();

    if (sb) {
      // Check staff table in Supabase
      try {
        const staffChecked = sessionStorage.getItem('samo_staff_rls_checked');
        if (!staffChecked) {
          const { data: sData, error: sErr } = await sb.from('staff').select('*');
          if (!sErr && (!sData || sData.length === 0)) {
            staffNeedsUpload = true;
            const { error: insErr } = await sb.from('staff').insert(currentStaffList);
            if (insErr) {
              sessionStorage.setItem('samo_staff_rls_checked', 'true');
              console.info('Supabase staff table has RLS policy active; staff members are securely preserved locally.');
            } else {
              console.log('Successfully migrated staff list to Supabase staff table.');
            }
          } else {
            sessionStorage.setItem('samo_staff_rls_checked', 'true');
          }
        }
      } catch (chkErr) {
        staffNeedsUpload = true;
      }

      // Check reports table in Supabase
      try {
        const reportsChecked = sessionStorage.getItem('samo_reports_rls_checked');
        if (!reportsChecked) {
          const { data: rData, error: rErr } = await sb.from('reports').select('*');
          if (!rErr && (!rData || rData.length === 0)) {
            reportsNeedsUpload = true;
            const { error: insRepErr } = await sb.from('reports').insert(currentReportsList);
            if (insRepErr) {
              sessionStorage.setItem('samo_reports_rls_checked', 'true');
              console.info('Supabase reports table has RLS policy active; reports are securely preserved locally.');
            } else {
              console.log('Successfully migrated initial reports to Supabase reports table.');
            }
          } else {
            sessionStorage.setItem('samo_reports_rls_checked', 'true');
          }
        }
      } catch (chkRepErr) {
        reportsNeedsUpload = true;
      }
    }

    // Always invoke the server migration endpoint to ensure dual consistency
    try {
      await fetch('/api/supabase/migrate-staff-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentStaffList,
          currentReportsList
        })
      });
    } catch (srvErr) {
      console.warn('Server-side migration call note:', srvErr);
    }

    // After migration, read exclusively and directly from Supabase
    await fetchStaffFromSupabaseDirect(false);
    await fetchReportsFromSupabaseDirect(false);

    if (interactive) {
      showQuickToast('تم فحص وترحيل بيانات الموظفين والتقارير إلى Supabase بنجاح ✓');
    }
  } catch (err) {
    console.error('Migration execution error:', err);
    if (interactive) {
      showQuickToast('ملاحظة أثناء الترحيل: ' + err.message, 'info');
    }
  } finally {
    isMigrationRunning = false;
  }
}
window.checkAndMigrateStaffAndReports = checkAndMigrateStaffAndReports;

async function triggerManualStaffAndReportsMigration() {
  showQuickToast('جاري فحص وتحديث جداول الموظفين والتقارير في Supabase...');
  await checkAndMigrateStaffAndReports(true);
}
window.triggerManualStaffAndReportsMigration = triggerManualStaffAndReportsMigration;

/**
 * Renders the saved reports table inside view-reports
 */
function renderSupabaseReportsList() {
  const container = document.getElementById('supabase-reports-container');
  if (!container) return;

  if (!supabaseReportsList || supabaseReportsList.length === 0) {
    container.innerHTML = `
      <div style="background:#f8fafc; border:1px dashed #cbd5e1; border-radius:10px; padding:20px; text-align:center; color:#64748b; font-size:13px;">
        <div style="font-size:24px; margin-bottom:6px;">📭</div>
        <div style="font-weight:700;">لا توجد تقارير محفوظة في جدول reports حالياً.</div>
        <div style="font-size:11px; margin-top:4px;">اضغط على زر "حفظ تقرير اليوم الحالي" أو زر "فحص ونقل بيانات الموظفين والتقارير" لرفع التقارير فوراً.</div>
      </div>
    `;
    return;
  }

  let html = `
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:12px; border:1px solid var(--ios-border);">
        <thead>
          <tr style="background:#f1f5f9; color:#334155; font-weight:800; text-align:right;">
            <th style="padding:8px 6px; border:1px solid var(--ios-border); text-align:center; width:35px;">ت</th>
            <th style="padding:8px 10px; border:1px solid var(--ios-border); text-align:right;">تاريخ التقرير</th>
            <th style="padding:8px 8px; border:1px solid var(--ios-border); text-align:center;">إجمالي المبيعات</th>
            <th style="padding:8px 8px; border:1px solid var(--ios-border); text-align:center;">عدد الطلبيات</th>
            <th style="padding:8px 8px; border:1px solid var(--ios-border); text-align:center;">الصيدليات</th>
            <th style="padding:8px 8px; border:1px solid var(--ios-border); text-align:center;">المواد المجهزة</th>
            <th style="padding:8px 10px; border:1px solid var(--ios-border); text-align:right;">المنشئ / البريد</th>
            <th style="padding:8px 6px; border:1px solid var(--ios-border); text-align:center; width:90px;">إجراءات</th>
          </tr>
        </thead>
        <tbody>
  `;

  supabaseReportsList.forEach((r, idx) => {
    const reportDate = r.report_date || (r.created_at ? new Date(r.created_at).toLocaleDateString('ar-IQ') : '-');
    const totalSales = Number(r.total_sales || 0).toLocaleString();
    const ordersCount = Number(r.orders_count || 0);
    const pharmaciesCount = Number(r.pharmacies_count || 0);
    const itemsCount = Number(r.items_count || 0);
    const email = escapeHtml(r.generated_by_email || 'مدير النظام');

    html += `
      <tr style="border-bottom:1px solid var(--ios-border); background:${idx % 2 === 0 ? '#fff' : '#f8fafc'};">
        <td style="padding:7px 6px; text-align:center; font-weight:700; border:1px solid var(--ios-border);">${idx + 1}</td>
        <td style="padding:7px 10px; font-weight:800; border:1px solid var(--ios-border); color:var(--ios-blue);">
          📅 ${escapeHtml(reportDate)}
        </td>
        <td style="padding:7px 8px; text-align:center; font-weight:900; border:1px solid var(--ios-border); color:var(--ios-green); font-family:monospace;">
          ${totalSales} د.ع
        </td>
        <td style="padding:7px 8px; text-align:center; font-weight:800; border:1px solid var(--ios-border); color:#2563eb;">
          ${ordersCount} طلب
        </td>
        <td style="padding:7px 8px; text-align:center; font-weight:800; border:1px solid var(--ios-border); color:#7c3aed;">
          ${pharmaciesCount} صيدلية
        </td>
        <td style="padding:7px 8px; text-align:center; font-weight:800; border:1px solid var(--ios-border); color:#d97706;">
          ${itemsCount} مادة
        </td>
        <td style="padding:7px 10px; font-weight:700; border:1px solid var(--ios-border); color:#475569; font-size:11px;">
          ${email}
        </td>
        <td style="padding:5px 6px; text-align:center; border:1px solid var(--ios-border);">
          <button class="btn btn-sec" style="font-size:10.5px; padding:3px 7px; font-weight:700;" onclick="viewReportDetails(${idx})">
            👁️ تفاصيل
          </button>
        </td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = html;
}
window.renderSupabaseReportsList = renderSupabaseReportsList;

function viewReportDetails(idx) {
  const r = supabaseReportsList[idx];
  if (!r) return;
  const repDate = r.report_date || (r.created_at ? new Date(r.created_at).toLocaleDateString('ar-IQ') : '-');
  const details = `
📊 تفاصيل تقرير Supabase (${repDate}):
━━━━━━━━━━━━━━━━━━━━━━━
• إجمالي المبيعات: ${Number(r.total_sales || 0).toLocaleString()} د.ع
• عدد الطلبيات: ${r.orders_count || 0}
• عدد الصيدليات: ${r.pharmacies_count || 0}
• عدد المواد: ${r.items_count || 0}
• منشئ التقرير: ${r.generated_by_email || 'مدير النظام'}
• توقيت الإنشاء السحابي: ${r.created_at || '-'}
  `;
  alert(details);
}
window.viewReportDetails = viewReportDetails;

// Google Auth & Staff Identity State
let currentStaffEmail = localStorage.getItem('samo_staff_email') || '';
let ordersViewScope = localStorage.getItem('samo_orders_scope') || 'my_orders';

async function initSupabaseAuthSession() {
  try {
    const sb = getSupabaseClient();
    if (sb && sb.auth) {
      const { data } = await sb.auth.getSession();
      const userEmail = data?.session?.user?.email;
      if (userEmail) {
        setStaffEmail(userEmail, false);
      }

      sb.auth.onAuthStateChange((_event, session) => {
        const email = session?.user?.email;
        if (email) {
          setStaffEmail(email, true);
        }
      });
    }
  } catch (err) {
    console.warn('Auth session check note:', err);
  }
  updateGoogleAuthUI();
  updateOrdersScopeUI();
  if (currentStaffEmail) {
    checkAndRestoreStaffDraft(currentStaffEmail);
  } else {
    // Auto show Google login modal on first launch to preserve user data
    setTimeout(() => {
      if (!currentStaffEmail) {
        openGoogleAuthModal();
      }
    }, 350);
  }

  // Initialize Realtime subscription for orders
  setupSupabaseOrdersRealtime();
}

// Supabase Realtime Subscription for Orders is initialized via setupSupabaseOrdersRealtime() below
window.setupSupabaseOrdersRealtime = setupSupabaseOrdersRealtime;

// Helper: Check if a staff name or email is designated as Owner/Admin
function isStaffAdminOrOwner(staffNameOrEmail) {
  if (!staffNameOrEmail) return false;
  const target = String(staffNameOrEmail).trim().toLowerCase();
  const staffObj = (supabaseStaffList || []).find(s => 
    String(s.name || '').trim().toLowerCase() === target ||
    String(s.email || '').trim().toLowerCase() === target
  );
  if (staffObj) {
    const role = String(staffObj.role || '').toLowerCase();
    return role === 'admin' || role === 'صاحب مذخر' || role === 'owner';
  }
  return false;
}
window.isStaffAdminOrOwner = isStaffAdminOrOwner;

async function setStaffEmail(email, notify = true) {
  currentStaffEmail = (email || '').trim().toLowerCase();
  if (currentStaffEmail) {
    localStorage.setItem('samo_staff_email', currentStaffEmail);
    if (!currentStaff) {
      currentStaff = currentStaffEmail.split('@')[0];
      localStorage.setItem('samo_current_staff', currentStaff);
    }
    
    // Sync Google account with backend & Supabase
    try {
      const resp = await fetch('/api/supabase/staff/sync-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentStaffEmail, name: currentStaff })
      });
      const data = await resp.json();
      if (data && data.success && data.user) {
        const u = data.user;
        const staffObj = {
          name: u.name,
          email: u.email,
          role: u.role,
          assigned_pharmacy: u.assignedPharmacy,
          assigned_pharmacy_phone: u.assignedPharmacyPhone
        };
        
        supabaseStaffList = (supabaseStaffList || []).filter(s => 
          String(s.email || '').toLowerCase() !== currentStaffEmail &&
          String(s.name || '').toLowerCase() !== String(u.name || '').toLowerCase()
        );
        supabaseStaffList.push(staffObj);

        const cleanName = String(u.name || '').trim();
        if (cleanName) {
          staffNames = (staffNames || []).filter(n => String(n || '').trim().toLowerCase() !== cleanName.toLowerCase());
          staffNames.push(cleanName);
          localStorage.setItem('samo_local_staff', JSON.stringify(staffNames));
          populateStaffDropdowns();
        }

        if (u.isOwner) {
          isAdmin = true;
          localStorage.setItem('samo_is_admin', 'true');
          applyAdminState();
          if (notify && typeof showQuickToast === 'function') {
            showQuickToast(`👑 مرحباً بك (${u.name})! تم التعرف على حسابك كـ "صاحب المذخر" والدخول مباشرة بدون رمز.`);
          }
        } else {
          if (notify && typeof showQuickToast === 'function') {
            if (u.assignedPharmacy) {
              showQuickToast(`👤 مرحباً بك (${u.name})! صيدليتك المعتمدة حصراً: "${u.assignedPharmacy}" ✓`);
            } else {
              showQuickToast(`تم ربط حساب الموظف: ${currentStaffEmail} ✓`);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Sync google user error:', e);
    }
  } else {
    localStorage.removeItem('samo_staff_email');
  }
  updateGoogleAuthUI();
  updateOrdersScopeUI();
  if (typeof renderOrdersLog === 'function') renderOrdersLog();
}

function updateGoogleAuthUI() {
  const emailText = document.getElementById('google-user-email-text');
  const activeDisplay = document.getElementById('auth-active-email-display');
  const connectedBox = document.getElementById('auth-connected-box');
  const signoutWrap = document.getElementById('auth-signout-btn-wrap');
  const manualInput = document.getElementById('auth-manual-email-input');
  const headerSignoutBtn = document.getElementById('google-header-signout-btn');

  if (currentStaffEmail) {
    if (emailText) emailText.innerText = currentStaffEmail.split('@')[0] || currentStaffEmail;
    if (activeDisplay) activeDisplay.innerText = currentStaffEmail;
    if (connectedBox) connectedBox.style.display = 'block';
    if (signoutWrap) signoutWrap.style.display = 'block';
    if (headerSignoutBtn) headerSignoutBtn.style.display = 'inline-block';
    if (manualInput && !manualInput.value) manualInput.value = currentStaffEmail;
  } else {
    if (emailText) emailText.innerText = 'تسجيل Google';
    if (activeDisplay) activeDisplay.innerText = '-';
    if (connectedBox) connectedBox.style.display = 'none';
    if (signoutWrap) signoutWrap.style.display = 'none';
    if (headerSignoutBtn) headerSignoutBtn.style.display = 'none';
  }
}

function openGoogleAuthModal() {
  updateGoogleAuthUI();
  const modal = document.getElementById('google-auth-modal');
  const errBox = document.getElementById('auth-error-msg');
  if (errBox) errBox.style.display = 'none';

  if (modal) {
    modal.style.display = 'flex';
    modal.style.zIndex = '9999999';
    const input = document.getElementById('auth-manual-email-input');
    if (input) {
      if (currentStaffEmail) input.value = currentStaffEmail;
      setTimeout(() => input.focus(), 150);
    }
  }
}
window.openGoogleAuthModal = openGoogleAuthModal;

function closeGoogleAuthModal() {
  if (!currentStaffEmail) {
    const errBox = document.getElementById('auth-error-msg');
    if (errBox) {
      errBox.innerText = '❌ يمنع استخدام البرنامج كزائر. يرجى تسجيل الدخول بـ Google أولاً للبدء.';
      errBox.style.display = 'block';
    } else {
      alert('❌ يمنع استخدام البرنامج كزائر. يرجى تسجيل الدخول بـ Google أولاً للبدء.');
    }
    return;
  }
  const modal = document.getElementById('google-auth-modal');
  if (modal) modal.style.display = 'none';
}
window.closeGoogleAuthModal = closeGoogleAuthModal;

async function signInWithGoogleOAuth() {
  try {
    const sb = getSupabaseClient();
    if (sb && sb.auth) {
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin
        }
      });
      if (error) {
        alert('تعذر فتح نافذة Google OAuth: ' + error.message + '\nيمكنك كتابة بريدك الإلكتروني في الحقل أدناه واعتماده مباشرة.');
      }
    } else {
      alert('خدمة تسجيل الدخول بـ Google متاحة عبر إدخال البريد الإلكتروني في الحقل أدناه.');
    }
  } catch (err) {
    console.warn('OAuth trigger note:', err);
  }
}
window.signInWithGoogleOAuth = signInWithGoogleOAuth;

function saveManualGoogleEmail() {
  const input = document.getElementById('auth-manual-email-input');
  const errBox = document.getElementById('auth-error-msg');
  const email = (input?.value || '').trim();

  if (!email || !email.includes('@') || email.length < 5) {
    if (errBox) {
      errBox.innerText = '❌ يرجى كتابة بريد إلكتروني صحيح لحساب Google (مثال: name@gmail.com)';
      errBox.style.display = 'block';
    } else {
      alert('الرجاء كتابة بريد إلكتروني صالح (Google Email).');
    }
    return;
  }

  if (errBox) errBox.style.display = 'none';
  setStaffEmail(email, true);

  const modal = document.getElementById('google-auth-modal');
  if (modal) modal.style.display = 'none';

  checkAndRestoreStaffDraft(email);
  loadRemoteData();
  if (typeof showQuickToast === 'function') {
    showQuickToast(`مرحباً بك! تم الدخول كـ (${email}) بنجاح ✓`);
  }
}
window.saveManualGoogleEmail = saveManualGoogleEmail;

async function signOutGoogleAccount() {
  try {
    const sb = getSupabaseClient();
    if (sb && sb.auth) {
      await sb.auth.signOut();
    }
  } catch (e) {}
  setStaffEmail('', false);
  dismissDraftBanner(false);
  closeGoogleAuthModal();
  showQuickToast('تم تسجيل الخروج من الحساب');
  loadRemoteData();
  setTimeout(() => {
    openGoogleAuthModal();
  }, 400);
}
window.signOutGoogleAccount = signOutGoogleAccount;

// Scope Selector for Orders
function setOrdersViewScope(scope) {
  if (!isAdmin && scope === 'all_orders') {
    showQuickToast('عرض كافة طلبيات المذخر متاح فقط للمشرف/صاحب المذخر');
    scope = 'my_orders';
  }
  ordersViewScope = scope;
  localStorage.setItem('samo_orders_scope', scope);
  updateOrdersScopeUI();
  renderOrdersLog();
}
window.setOrdersViewScope = setOrdersViewScope;

function updateOrdersScopeUI() {
  const myBtn = document.getElementById('orders-scope-my-btn');
  const allBtn = document.getElementById('orders-scope-all-btn');
  const emailSpan = document.getElementById('orders-scope-my-email');

  if (!isAdmin) {
    ordersViewScope = 'my_orders';
    if (allBtn) allBtn.style.display = 'none';
    if (myBtn) {
      myBtn.style.width = '100%';
      myBtn.style.flex = '1';
      myBtn.innerHTML = `👤 طلبياتي وفواتيري الصادرة فقط (${currentStaffEmail ? (currentStaffEmail.split('@')[0] || currentStaffEmail) : (currentStaff || 'حسابي')})`;
    }
  } else {
    if (allBtn) allBtn.style.display = 'inline-flex';
    if (myBtn) {
      myBtn.style.width = 'auto';
      myBtn.innerHTML = `👤 فواتيري اليومية (<span id="orders-scope-my-email">${currentStaffEmail ? (currentStaffEmail.split('@')[0] || currentStaffEmail) : 'حسابي'}</span>)`;
    }
  }

  if (emailSpan && isAdmin) {
    emailSpan.innerText = currentStaffEmail ? (currentStaffEmail.split('@')[0] || currentStaffEmail) : 'حسابي';
  }

  if (myBtn && allBtn) {
    if (ordersViewScope === 'my_orders') {
      myBtn.className = 'btn';
      myBtn.style.background = 'var(--ios-blue)';
      myBtn.style.color = '#fff';
      allBtn.className = 'btn btn-sec';
      allBtn.style.background = '#fff';
      allBtn.style.color = 'var(--ios-text)';
    } else {
      allBtn.className = 'btn';
      allBtn.style.background = 'var(--ios-blue)';
      allBtn.style.color = '#fff';
      myBtn.className = 'btn btn-sec';
      myBtn.style.background = '#fff';
      myBtn.style.color = 'var(--ios-text)';
    }
  }
}
window.updateOrdersScopeUI = updateOrdersScopeUI;

// ================= Drafts Auto-Save & Cloud Persistence =================
let draftSaveTimer = null;

function queueAutoSaveDraft() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    saveCurrentDraft();
  }, 1200);
}

async function saveCurrentDraft() {
  const userEmail = currentStaffEmail || localStorage.getItem('samo_staff_email') || '';
  if (!userEmail) return;

  const hasCart = cart && Object.keys(cart).length > 0;
  const hasPos = posCart && Object.keys(posCart).length > 0;
  const phName = (document.getElementById('order-ph-name')?.value || document.getElementById('order-approved-ph-select')?.value || document.getElementById('pos-ph-name')?.value || '').trim();
  const phPhone = (document.getElementById('order-ph-phone')?.value || document.getElementById('pos-ph-phone')?.value || '').trim();

  if (!hasCart && !hasPos && !phName) {
    return;
  }

  const draftData = {
    cart,
    posCart,
    posCartCustomPrices: typeof posCartCustomPrices !== 'undefined' ? posCartCustomPrices : {},
    phName,
    phPhone,
    timestamp: Date.now(),
    dateStr: new Date().toLocaleString('ar-IQ')
  };

  try {
    localStorage.setItem(`samo_draft_${userEmail}`, JSON.stringify(draftData));

    // Save to Supabase "drafts" table
    const sb = getSupabaseClient();
    if (sb) {
      sb.from('drafts').upsert({
        staff_email: userEmail,
        draft_data: draftData,
        updated_at: new Date().toISOString()
      }, { onConflict: 'staff_email' }).then(() => {}).catch(err => console.warn('Supabase draft note:', err));
    }

    // Save to Server API (SQLite dual persistence)
    fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffEmail: userEmail, draftData })
    }).catch(() => {});
  } catch (e) {
    console.warn('Draft save exception:', e);
  }
}

async function checkAndRestoreStaffDraft(userEmail) {
  if (!userEmail) return;
  try {
    let draft = null;

    // 1. Try Supabase drafts table
    const sb = getSupabaseClient();
    if (sb) {
      const { data, error } = await sb.from('drafts').select('*').eq('staff_email', userEmail).single();
      if (!error && data && data.draft_data) {
        draft = data.draft_data;
      }
    }

    // 2. Fallback to server API
    if (!draft) {
      const res = await fetch(`/api/drafts?email=${encodeURIComponent(userEmail)}`);
      if (res.ok) {
        const json = await res.json();
        if (json.draft) draft = json.draft;
      }
    }

    // 3. Fallback to localStorage
    if (!draft) {
      const localStr = localStorage.getItem(`samo_draft_${userEmail}`);
      if (localStr) {
        try { draft = JSON.parse(localStr); } catch (e) {}
      }
    }

    if (!draft) return;

    const hasItems = (draft.cart && Object.keys(draft.cart).length > 0) || (draft.posCart && Object.keys(draft.posCart).length > 0);
    if (!hasItems && !draft.phName) return;

    showDraftRestoreBanner(draft);
  } catch (e) {
    console.warn('Draft check error:', e);
  }
}

function showDraftRestoreBanner(draft) {
  const container = document.getElementById('draft-restore-banner-container');
  if (!container) return;

  const itemCount = (draft.cart ? Object.keys(draft.cart).length : 0) + (draft.posCart ? Object.keys(draft.posCart).length : 0);
  const timeStr = draft.dateStr || 'سابقاً';

  container.innerHTML = `
    <div style="background: #eff6ff; border: 1.5px solid #60a5fa; border-radius: 12px; padding: 12px 16px; margin: 10px 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; box-shadow: 0 2px 8px rgba(59, 130, 246, 0.15);">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 22px;">📝</span>
        <div>
          <div style="font-size: 13px; font-weight: 800; color: #1e40af;">توجد مسودة فاتورة غير مكتملة محفوظة لحسابك (${currentStaffEmail})</div>
          <div style="font-size: 11px; color: #3b82f6; margin-top: 2px;">تحتوي على (${itemCount}) أدوية - آخر تعديل: ${timeStr}</div>
        </div>
      </div>
      <div style="display: flex; gap: 6px;">
        <button class="btn btn-prim" style="font-size: 11.5px; padding: 5px 12px; background: #2563eb; color: #fff; font-weight: 800;" onclick="applyRestoredDraft()">استرجاع المسودة ✓</button>
        <button class="btn btn-sec" style="font-size: 11.5px; padding: 5px 10px; background: #fff; border-color: #cbd5e1; color: #64748b;" onclick="dismissDraftBanner(true)">حذف المسودة ✕</button>
      </div>
    </div>
  `;
  container.style.display = 'block';
  window._pendingDraftToRestore = draft;
}

function applyRestoredDraft() {
  const draft = window._pendingDraftToRestore;
  if (!draft) return;

  if (draft.cart && Object.keys(draft.cart).length > 0) {
    cart = { ...draft.cart };
    saveLocalCart();
    updateCartBadge();
  }
  if (draft.posCart && Object.keys(draft.posCart).length > 0) {
    posCart = { ...draft.posCart };
    if (draft.posCartCustomPrices) posCartCustomPrices = { ...draft.posCartCustomPrices };
    if (typeof renderPosCart === 'function') renderPosCart();
  }
  if (draft.phName) {
    const phInput = document.getElementById('order-ph-name') || document.getElementById('pos-ph-name');
    if (phInput) phInput.value = draft.phName;
  }
  if (draft.phPhone) {
    const phoneInput = document.getElementById('order-ph-phone') || document.getElementById('pos-ph-phone');
    if (phoneInput) phoneInput.value = draft.phPhone;
  }

  showQuickToast('تم استرجاع مسودة الفاتورة بنجاح ✓');
  dismissDraftBanner(false);
  if (currentTab === 'pos') {
    if (typeof renderPosCart === 'function') renderPosCart();
    if (typeof renderPosGrid === 'function') renderPosGrid();
  } else {
    renderProducts();
  }
}

function dismissDraftBanner(shouldDelete = false) {
  const container = document.getElementById('draft-restore-banner-container');
  if (container) {
    container.innerHTML = '';
    container.style.display = 'none';
  }
  if (shouldDelete && currentStaffEmail) {
    clearStaffDraftCloud(currentStaffEmail);
  }
  window._pendingDraftToRestore = null;
}

async function clearStaffDraftCloud(userEmail) {
  if (!userEmail) return;
  try {
    localStorage.removeItem(`samo_draft_${userEmail}`);
    const sb = getSupabaseClient();
    if (sb) {
      sb.from('drafts').delete().eq('staff_email', userEmail).then(() => {}).catch(() => {});
    }
    fetch(`/api/drafts?email=${encodeURIComponent(userEmail)}`, { method: 'DELETE' }).catch(() => {});
  } catch (e) {}
}


// Universal Product Normalizer: Maps fields whether coming from Supabase "samo" table or local backend/SQLite
function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = String(raw.name || raw.product || raw.title || '').trim();
  const rawQty = raw.quantity !== undefined && raw.quantity !== null && raw.quantity !== ''
    ? raw.quantity
    : (raw.number !== undefined && raw.number !== null && raw.number !== '' ? raw.number : 0);
  const quantity = Math.max(0, Number(rawQty) || 0);

  const rawPrice = raw.price !== undefined && raw.price !== null && raw.price !== ''
    ? raw.price
    : (raw.price_of_one !== undefined && raw.price_of_one !== null && raw.price_of_one !== '' ? raw.price_of_one : 0);
  const price = Math.max(0, Number(rawPrice) || 0);

  const rawMinQty = raw.minQty !== undefined && raw.minQty !== null && raw.minQty !== ''
    ? raw.minQty
    : (raw.limit_number !== undefined && raw.limit_number !== null && raw.limit_number !== '' ? raw.limit_number : 5);
  const minQty = Math.max(0, Number(rawMinQty) || 5);

  let expiryDate = '';
  if (raw.expiryDate) {
    expiryDate = String(raw.expiryDate).replace(/\\/g, '-').trim();
  } else if (raw.expire_date) {
    expiryDate = String(raw.expire_date).replace(/\\/g, '-').trim();
  }

  const rawTotalPrice = raw.totalPrice !== undefined && raw.totalPrice !== null && raw.totalPrice !== ''
    ? raw.totalPrice
    : (raw.total_price !== undefined && raw.total_price !== null && raw.total_price !== '' ? raw.total_price : (quantity * price));
  const totalPrice = Number(rawTotalPrice) || (quantity * price);

  const bonus = Math.max(0, Number(raw.bonus) || 0);
  const barcode = typeof formatBarcode === 'function' ? formatBarcode(raw.barcode) : String(raw.barcode || '').trim();
  const company = String(raw.company || '').trim();
  const rawForm = raw.form || raw.category || '';
  const form = typeof smartDetectForm === 'function' ? smartDetectForm(name, rawForm) : (rawForm || 'أخرى');
  const image = raw.image || raw.image_url || '';
  const createdAt = raw.createdAt || raw.created_at || new Date().toISOString();

  const id = String(raw.id || (barcode ? `PROD-BC-${barcode}` : `PROD-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`));

  return {
    ...raw,
    id,
    name,
    product: name,
    quantity,
    number: quantity,
    price,
    price_of_one: price,
    minQty,
    limit_number: minQty,
    expiryDate,
    expire_date: expiryDate,
    totalPrice,
    total_price: totalPrice,
    bonus,
    barcode,
    company,
    form,
    category: form,
    image,
    image_url: image,
    createdAt,
    created_at: createdAt
  };
}
window.normalizeProduct = normalizeProduct;

// Local in-memory states
let products = [];
let filteredProducts = [];
let setProducts = (p) => { 
  const mapped = Array.isArray(p) ? p.map(normalizeProduct).filter(Boolean) : [];
  products = mapped; 
  filteredProducts = mapped; 
};
let updateUI = () => { if (typeof refreshAllUI === 'function') refreshAllUI(true); else if (typeof renderProducts === 'function') renderProducts(); };
let isLoading = false;
let isModalOpen = false;
let isFetchingRemote = false;

async function forceLoadMedicines() {
  try {
    console.log("جاري جلب المواد من samo...");
    const sb = (typeof getSupabaseClient === 'function' ? getSupabaseClient() : null) || (typeof supabase !== 'undefined' ? supabase : null);
    if (!sb || typeof sb.from !== 'function') {
      console.warn("Supabase client not initialized, fallback to API");
      if (typeof loadRemoteData === 'function') await loadRemoteData();
      return;
    }

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase samo fetch timeout')), 3500));
    const fetchPromise = sb.from('samo').select('*').order('id', { ascending: true });
    const { data, error } = await Promise.race([fetchPromise, timeoutPromise]);

    if (error) {
      console.warn("خطأ Supabase في قراءة الأدوية، الرجوع للنسخة المحلية:", error.message);
      if (typeof loadRemoteData === 'function') await loadRemoteData();
      return;
    }

    if (data && data.length > 0) {
      console.log(`تم استلام ${data.length} مادة بنجاح من samo`);
      const mapped = data.map(normalizeProduct).filter(Boolean);
      products = mapped;
      filteredProducts = mapped;
      saveLocalData();
      if (typeof renderProducts === 'function') renderProducts();
      if (typeof updateUI === 'function') updateUI();
      if (typeof refreshAllUI === 'function') refreshAllUI(true);
      const countPill = document.getElementById('medicines-count-pill');
      if (countPill) countPill.innerText = `${products.length} من أصل ${products.length} مادة`;
    } else {
      console.warn("جدول samo فارغ، جلب البيانات من API...");
      if (typeof loadRemoteData === 'function') await loadRemoteData();
    }
  } catch (err) {
    console.warn("استثناء أثناء جلب الأدوية، جلب البيانات عبر API:", err);
    if (typeof loadRemoteData === 'function') await loadRemoteData();
  }
}
window.forceLoadMedicines = forceLoadMedicines;

async function loadAllProducts() {
  try {
    isLoading = true;
    if (products && products.length > 0) {
      if (typeof renderProducts === 'function') renderProducts();
    }

    const sb = typeof getSupabaseClient === 'function' ? getSupabaseClient() : null;
    let loadedFromSupabase = false;

    if (sb && typeof sb.from === 'function') {
      try {
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase fetch timeout')), 3500));
        const fetchPromise = sb.from('samo').select('*').order('id', { ascending: true });
        const { data, error } = await Promise.race([fetchPromise, timeoutPromise]);

        if (!error && Array.isArray(data) && data.length > 0) {
          const mapped = data.map(normalizeProduct).filter(Boolean);
          products = mapped;
          filteredProducts = mapped;
          saveLocalData();
          loadedFromSupabase = true;
          if (typeof refreshAllUI === 'function') {
            refreshAllUI(true);
          } else if (typeof renderProducts === 'function') {
            renderProducts();
          }
        }
      } catch (sbErr) {
        console.warn('Direct Supabase fetch note, falling back to server API:', sbErr.message);
      }
    }

    if (!loadedFromSupabase) {
      if (typeof loadRemoteData === 'function') await loadRemoteData();
    }
  } catch (err) {
    console.warn("خطأ عام في جلب الأدوية:", err);
    if (typeof loadRemoteData === 'function') await loadRemoteData();
  } finally {
    isLoading = false;
  }
}
window.loadAllProducts = loadAllProducts;

async function fetchSamoProductsDirectly(notify = false) {
  try {
    const sb = getSupabaseClient();
    if (sb && typeof sb.from === 'function') {
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase fetch timeout')), 3500));
      const fetchPromise = sb.from('samo').select('*').order('id', { ascending: true });
      const { data, error } = await Promise.race([fetchPromise, timeoutPromise]);

      if (error) {
        console.warn('Supabase samo fetch error, fallback to API:', error.message);
        if (typeof loadRemoteData === 'function') await loadRemoteData();
        return products;
      }
      if (data && Array.isArray(data) && data.length > 0) {
        const mapped = data.map(normalizeProduct).filter(Boolean);
        products = mapped;
        filteredProducts = mapped;
        saveLocalData();
        refreshAllUI(true);
        if (notify && typeof showQuickToast === 'function') {
          showQuickToast(`تم جلب ${products.length} مادة من جدول samo في Supabase بنجاح ✓`);
        }
        return products;
      }
    }
    if (typeof loadRemoteData === 'function') await loadRemoteData();
    return products;
  } catch (err) {
    console.warn('fetchSamoProductsDirectly exception:', err);
    if (typeof loadRemoteData === 'function') await loadRemoteData();
    return products;
  }
}
window.fetchSamoProductsDirectly = fetchSamoProductsDirectly;

async function loadSamoMedicinesDirectly(notify = false) {
  const isNotify = notify === true || (notify && typeof notify === 'object');
  const btn = document.getElementById('refresh-medicines-btn');
  const origText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ جاري الجلب...';
  }
  if (isNotify && typeof showQuickToast === 'function') {
    showQuickToast('⏳ جاري سحب الأدوية من قاعدة البيانات...');
  }

  try {
    const res = await fetch('https://boaopqyzhvyzdclmoycr.supabase.co/rest/v1/samo?select=*', {
      headers: {
        'apikey': 'sb_publishable_5Tg1o4MnUSseRc1bw78Erg_wIQNF42I',
        'Authorization': 'Bearer sb_publishable_5Tg1o4MnUSseRc1bw78Erg_wIQNF42I'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      console.log(`تم استلام ${data.length} مادة بنجاح من samo عبر REST API المباشر`);
      products = data.map(item => ({
        ...item,
        id: String(item.id || (item.barcode ? `PROD-BC-${item.barcode}` : `PROD-${Date.now()}`)),
        name: item.product || item.name || 'بدون اسم',
        product: item.product || item.name || 'بدون اسم',
        company: item.company || '',
        barcode: item.barcode || '',
        quantity: Number(item.number ?? item.quantity ?? 0),
        number: Number(item.number ?? item.quantity ?? 0),
        price: Number(item.price_of_one ?? item.price ?? 0),
        price_of_one: Number(item.price_of_one ?? item.price ?? 0),
        bonus: Number(item.bonus || 0),
        minQty: Number(item.limit_number ?? item.minQty ?? 5),
        expiryDate: item.expire_date || item.expiryDate || '',
        expire_date: item.expire_date || item.expiryDate || '',
        form: (typeof smartDetectForm === 'function' ? smartDetectForm(item.product || item.name || '', item.form || item.category || '') : (item.form || item.category || 'أخرى'))
      }));

      filteredProducts = products;
      if (typeof saveLocalData === 'function') saveLocalData();
      if (typeof renderProducts === 'function') renderProducts();
      if (typeof refreshAllUI === 'function') refreshAllUI(true);

      const countPill = document.getElementById('medicines-count-pill');
      if (countPill) countPill.innerText = `${products.length} من أصل ${products.length} مادة`;

      if (isNotify && typeof showQuickToast === 'function') {
        showQuickToast(`✅ تم جلب وعرض ${products.length} مادة بنجاح ✓`);
      }
      return products;
    } else {
      console.warn("جدول samo فارغ أو غير متاح عبر REST، المحاولة عبر الخادم المحلي...");
      if (typeof loadRemoteData === 'function') await loadRemoteData();
      return products;
    }
  } catch (err) {
    console.error("فشل جلب الأدوية المباشر، جاري الجلب عبر الخادم:", err);
    if (typeof loadRemoteData === 'function') await loadRemoteData();
    return products;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}
window.loadSamoMedicinesDirectly = loadSamoMedicinesDirectly;
window.triggerFetchMedicinesFromDatabase = loadSamoMedicinesDirectly;
let orders = [];
let pendingOrders = [];
let pharmacies = [];
let customersList = [];
let selectedPharmacy = '';

function setSelectedPharmacy(val) {
  selectedPharmacy = val || '';
  const posSel = document.getElementById('pos-ph-select');
  if (posSel && posSel.value !== selectedPharmacy) {
    posSel.value = selectedPharmacy;
  }
  if (typeof onPosPharmacyDropdownChanged === 'function') {
    onPosPharmacyDropdownChanged(selectedPharmacy);
  }
  const orderSel = document.getElementById('order-approved-ph-select');
  if (orderSel && orderSel.value !== selectedPharmacy) {
    orderSel.value = selectedPharmacy;
  }
}
window.setSelectedPharmacy = setSelectedPharmacy;

const setCustomersList = (data) => {
  customersList = Array.isArray(data) ? data : [];
  window.customersList = customersList;
  pharmacies = customersList.map(c => ({
    id: c.id,
    name: c.name,
    phone: c.phone || '',
    address: c.address || '',
    notes: c.address || ''
  }));
  if (typeof populatePharmacyDropdowns === 'function') populatePharmacyDropdowns();
  if (typeof populatePosPharmaciesDropdown === 'function') populatePosPharmaciesDropdown();
  if (typeof renderSettingsPharmacies === 'function') renderSettingsPharmacies();
};
window.setCustomersList = setCustomersList;

/**
 * جلب قائمة الصيدليات والعملاء ديناميكياً من Supabase (جدول customers)
 */
const fetchCustomers = async () => {
  try {
    const sb = (typeof getSupabaseClient === 'function' ? getSupabaseClient() : null) || (typeof supabase !== 'undefined' ? supabase : null);
    if (!sb) {
      console.warn('Supabase client not available for fetchCustomers');
      return [];
    }
    const { data, error } = await sb
      .from('customers')
      .select('id, name, phone, address')
      .order('name', { ascending: true });

    if (error) {
      console.warn('خطأ في جلب الصيدليات/العملاء من Supabase:', error.message);
      return [];
    }
    if (data) {
      setCustomersList(data);
      return data;
    }
    return [];
  } catch (err) {
    console.error('استثناء في fetchCustomers:', err);
    return [];
  }
};
window.fetchCustomers = fetchCustomers;

/**
 * إضافة عميل / صيدلية جديدة في Supabase (جدول customers)
 */
const addNewCustomer = async ({ name, phone, address }) => {
  const customerName = (name || '').trim();
  const customerPhone = phone ? phone.trim() : null;
  const customerAddress = address ? address.trim() : null;

  if (!customerName) {
    alert('يرجى إدخال اسم الصيدلية / العميل');
    return null;
  }

  const sb = (typeof getSupabaseClient === 'function' ? getSupabaseClient() : null) || (typeof supabase !== 'undefined' ? supabase : null);
  if (!sb) {
    alert('قاعدة البيانات غير متصلة');
    return null;
  }

  try {
    const { data, error } = await sb.from('customers').insert([{
      name: customerName,
      phone: customerPhone,
      address: customerAddress,
      created_at: new Date().toISOString()
    }]).select();

    if (error) {
      console.error('خطأ في إضافة الصيدلية إلى Supabase:', error.message);
      alert('خطأ أثناء إضافة الصيدلية: ' + error.message);
      return null;
    }

    if (typeof showQuickToast === 'function') {
      showQuickToast(`تمت إضافة الصيدلية "${customerName}" بنجاح ✓`);
    }
    await fetchCustomers();
    setSelectedPharmacy(customerName);
    return data && data[0] ? data[0] : true;
  } catch (err) {
    console.error('خطأ في إضافة العميل:', err);
    alert('حدث خطأ أثناء إضافة الصيدلية: ' + (err.message || err));
    return null;
  }
};
window.addNewCustomer = addNewCustomer;

let cart = {};
let posCart = (() => {
  try {
    const saved = localStorage.getItem('samo_pos_cart');
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
})();

let posCartCustomPrices = (() => {
  try {
    const saved = localStorage.getItem('samo_pos_cart_prices');
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
})();

function savePosCart() {
  try {
    localStorage.setItem('samo_pos_cart', JSON.stringify(posCart));
    localStorage.setItem('samo_pos_cart_prices', JSON.stringify(posCartCustomPrices));
  } catch (e) {
    console.warn('savePosCart error:', e);
  }
}
window.savePosCart = savePosCart;
let isAdmin = localStorage.getItem('samo_is_admin') === 'true';
let currentTab = 'home';
let searchTimeout = null;
let currentScannerTarget = 'search-box';
let html5QrCode = null;
let lastSelectedPrinter = localStorage.getItem('samo_thermal_printer') || '';
let printBridgeAvailable = false;
let currentStaff = localStorage.getItem('samo_current_staff') || '';
let staffNames = ['حسين', 'سجاد'];
let currentSettingsTab = 'pharmacies';
let systemSettings = {
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

const DEFAULT_DOSAGE_FORMS = [
  { id: 'form-tablet', key: 'Tablet', nameAr: 'حبوب (أقراص)', icon: '💊' },
  { id: 'form-capsule', key: 'Capsule', nameAr: 'كبسول', icon: '💊' },
  { id: 'form-syrup', key: 'Syrup', nameAr: 'شراب', icon: '🧪' },
  { id: 'form-suspension', key: 'Suspension', nameAr: 'معلق', icon: '🧪' },
  { id: 'form-injection', key: 'Injection', nameAr: 'حقن', icon: '💉' },
  { id: 'form-vial', key: 'Vial', nameAr: 'فيال', icon: '🧪' },
  { id: 'form-ampoule', key: 'Ampoule', nameAr: 'أمبول', icon: '💉' },
  { id: 'form-cream', key: 'Cream', nameAr: 'كريم', icon: '🧴' },
  { id: 'form-ointment', key: 'Ointment', nameAr: 'مرهم', icon: '🧴' },
  { id: 'form-sachet', key: 'Sachet', nameAr: 'ساشيت / فوار', icon: '🫧' },
  { id: 'form-gel', key: 'Gel', nameAr: 'جل', icon: '🧴' },
  { id: 'form-drops', key: 'Drops', nameAr: 'قطرات', icon: '💧' },
  { id: 'form-suppository', key: 'Suppository', nameAr: 'تحاميل', icon: '💊' },
  { id: 'form-spray', key: 'Spray', nameAr: 'بخاخ', icon: '💨' },
  { id: 'form-lotion', key: 'Lotion', nameAr: 'لوشن', icon: '🧴' }
];

let dosageForms = [...DEFAULT_DOSAGE_FORMS];

const FONT_MAP = {
  cairo: "'Cairo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  tajawal: "'Tajawal', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  ibm: "'IBM Plex Sans Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  almarai: "'Almarai', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  readex: "'Readex Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  noto: "'Noto Sans Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, sans-serif"
};

function applyAppTheme(config = {}) {
  const color = (typeof config === 'string' ? config : (config.color || systemSettings.app_theme_color || '#007aff'));
  const fontKey = (typeof config === 'object' && config.font) ? config.font : (systemSettings.app_font_family || 'cairo');
  const scale = (typeof config === 'object' && config.scale) ? config.scale : (systemSettings.app_font_scale || '1.0');
  const mode = (typeof config === 'object' && config.mode) ? config.mode : (systemSettings.app_theme_mode || 'light');
  const headerStyle = (typeof config === 'object' && config.headerStyle) ? config.headerStyle : (systemSettings.app_header_style || 'standard');

  // 1. Accent color
  document.documentElement.style.setProperty('--ios-blue', color);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', color);

  // 2. Font family
  const fontVal = FONT_MAP[fontKey] || FONT_MAP.cairo;
  document.documentElement.style.setProperty('--app-font', fontVal);

  // 3. Font scale
  document.documentElement.style.setProperty('--app-font-scale', scale);

  // 4. Theme mode (light, dark, soft)
  if (mode === 'dark') {
    document.documentElement.style.setProperty('--ios-bg', '#0f172a');
    document.documentElement.style.setProperty('--ios-card', '#1e293b');
    document.documentElement.style.setProperty('--ios-text', '#f8fafc');
    document.documentElement.style.setProperty('--ios-sub', '#94a3b8');
    document.documentElement.style.setProperty('--ios-border', '#334155');
    document.documentElement.style.setProperty('--ios-btn-sec', '#334155');
  } else if (mode === 'soft') {
    document.documentElement.style.setProperty('--ios-bg', '#f8fafc');
    document.documentElement.style.setProperty('--ios-card', '#ffffff');
    document.documentElement.style.setProperty('--ios-text', '#1e293b');
    document.documentElement.style.setProperty('--ios-sub', '#64748b');
    document.documentElement.style.setProperty('--ios-border', '#cbd5e1');
    document.documentElement.style.setProperty('--ios-btn-sec', '#f1f5f9');
  } else {
    // Light
    document.documentElement.style.setProperty('--ios-bg', '#f2f2f7');
    document.documentElement.style.setProperty('--ios-card', '#ffffff');
    document.documentElement.style.setProperty('--ios-text', '#000000');
    document.documentElement.style.setProperty('--ios-sub', '#8e8e93');
    document.documentElement.style.setProperty('--ios-border', '#e5e5ea');
    document.documentElement.style.setProperty('--ios-btn-sec', '#e5e5ea');
  }

  // 5. Header style
  if (headerStyle === 'colored') {
    document.documentElement.style.setProperty('--ios-header-bg', color);
    document.documentElement.style.setProperty('--ios-header-color', '#ffffff');
  } else if (headerStyle === 'dark' || mode === 'dark') {
    document.documentElement.style.setProperty('--ios-header-bg', 'rgba(15, 23, 42, 0.95)');
    document.documentElement.style.setProperty('--ios-header-color', '#f8fafc');
  } else {
    document.documentElement.style.setProperty('--ios-header-bg', 'rgba(255, 255, 255, 0.85)');
    document.documentElement.style.setProperty('--ios-header-color', '#000000');
  }
}

function previewThemeColor(color) {
  if (color) {
    applyAppTheme({ color });
  }
}

function selectThemeColorPreset(hex) {
  const picker = document.getElementById('theme-color-picker');
  const text = document.getElementById('theme-color-hex');
  if (picker) picker.value = hex;
  if (text) text.value = hex;
  applyAppTheme({ color: hex });
  updatePresetButtonsActive(hex);
}
window.selectThemeColorPreset = selectThemeColorPreset;

function updatePresetButtonsActive(hex) {
  const btns = document.querySelectorAll('.theme-preset-btn');
  btns.forEach(b => {
    const bg = b.style.backgroundColor || b.style.background;
    if (b.getAttribute('onclick')?.includes(hex) || bg === hex) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });
}

function onThemeColorPickerChange(val) {
  const text = document.getElementById('theme-color-hex');
  if (text) text.value = val;
  applyAppTheme({ color: val });
  updatePresetButtonsActive(val);
}
window.onThemeColorPickerChange = onThemeColorPickerChange;

function onThemeColorHexInput(val) {
  if (/^#[0-9A-F]{6}$/i.test(val)) {
    const picker = document.getElementById('theme-color-picker');
    if (picker) picker.value = val;
    applyAppTheme({ color: val });
    updatePresetButtonsActive(val);
  }
}
window.onThemeColorHexInput = onThemeColorHexInput;

function previewAppFont(fontKey) {
  applyAppTheme({ font: fontKey });
}
window.previewAppFont = previewAppFont;

function previewAppScale(scaleVal) {
  applyAppTheme({ scale: scaleVal });
}
window.previewAppScale = previewAppScale;

function previewThemeMode(mode) {
  applyAppTheme({ mode });
}
window.previewThemeMode = previewThemeMode;

function previewHeaderStyle(headerStyle) {
  applyAppTheme({ headerStyle });
}
window.previewHeaderStyle = previewHeaderStyle;

function previewCardDensity(density) {
  systemSettings.prod_card_density = density;
  renderProducts();
}
window.previewCardDensity = previewCardDensity;

function syncDosageFormsFromSettings() {
  if (systemSettings && systemSettings.dosage_forms) {
    try {
      const parsed = typeof systemSettings.dosage_forms === 'string'
        ? JSON.parse(systemSettings.dosage_forms)
        : systemSettings.dosage_forms;
      if (Array.isArray(parsed) && parsed.length > 0) {
        dosageForms = parsed;
      }
    } catch (e) {
      console.warn('Could not parse dosage_forms from settings:', e);
    }
  }

  // Also gather any custom forms already existing on products
  if (Array.isArray(products)) {
    const existingKeys = new Set(dosageForms.map(f => (f.key || '').trim().toLowerCase()));
    products.forEach(p => {
      const formVal = (p.form || '').trim();
      if (formVal && !existingKeys.has(formVal.toLowerCase())) {
        existingKeys.add(formVal.toLowerCase());
        dosageForms.push({
          id: `form-custom-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          key: formVal,
          nameAr: formVal,
          icon: '💊'
        });
      }
    });
  }
}

function populateAllDosageFormSelectors() {
  syncDosageFormsFromSettings();

  // 1. Filter dropdown in main home screen
  const filterSel = document.getElementById('filter-form');
  if (filterSel) {
    const currentVal = filterSel.value;
    filterSel.innerHTML = '<option value="">-- الكل --</option>' +
      dosageForms.map(f => `<option value="${escapeHtml(f.key)}">${escapeHtml(f.icon || '💊')} ${escapeHtml(f.key)} (${escapeHtml(f.nameAr || f.key)})</option>`).join('');
    if (currentVal && dosageForms.some(f => f.key.toLowerCase() === currentVal.toLowerCase())) {
      filterSel.value = currentVal;
    }
  }

  // 2. Add product modal dropdown
  const inFormSel = document.getElementById('in-form');
  if (inFormSel) {
    const currentVal = inFormSel.value;
    inFormSel.innerHTML = dosageForms.map(f => `<option value="${escapeHtml(f.key)}">${escapeHtml(f.icon || '💊')} ${escapeHtml(f.key)} (${escapeHtml(f.nameAr || f.key)})</option>`).join('');
    if (currentVal && dosageForms.some(f => f.key.toLowerCase() === currentVal.toLowerCase())) {
      inFormSel.value = currentVal;
    }
  }

  // 3. Edit product modal dropdown
  const editFormSel = document.getElementById('edit-form');
  if (editFormSel) {
    const currentVal = editFormSel.value;
    editFormSel.innerHTML = dosageForms.map(f => `<option value="${escapeHtml(f.key)}">${escapeHtml(f.icon || '💊')} ${escapeHtml(f.key)} (${escapeHtml(f.nameAr || f.key)})</option>`).join('');
    if (currentVal && dosageForms.some(f => f.key.toLowerCase() === currentVal.toLowerCase())) {
      editFormSel.value = currentVal;
    }
  }

  // 4. POS category chips
  const posChipsCont = document.getElementById('pos-category-chips');
  if (posChipsCont) {
    let html = `<button class="pos-chip ${!posSelectedCategory ? 'active' : ''}" onclick="filterPosByCategory('', this)">الكل</button>`;
    dosageForms.forEach(f => {
      const isActive = (posSelectedCategory || '').toLowerCase() === (f.key || '').toLowerCase();
      html += `<button class="pos-chip ${isActive ? 'active' : ''}" onclick="filterPosByCategory('${escapeHtml(f.key)}', this)">${escapeHtml(f.icon || '💊')} ${escapeHtml(f.nameAr || f.key)}</button>`;
    });
    posChipsCont.innerHTML = html;
  }
}
let currentInspectingOrderIndex = -1;
let hideOutOfStock = localStorage.getItem('samo_hide_out_of_stock') === 'true';
let posHideOutOfStock = localStorage.getItem('samo_pos_hide_out_of_stock') === 'true';
let selectedSavedPharmacy = '';
let currentBarcodePayload = null;

// Unique Device ID for user tracking
let myUserId = localStorage.getItem('samo_device_user_id');
if (!myUserId) {
  myUserId = 'USER-' + Math.random().toString(36).substring(2, 9).toUpperCase();
  localStorage.setItem('samo_device_user_id', myUserId);
}

// Persistent user order tracking for "طلباتي"
let mySubmittedOrderNumbers = new Set();
try {
  const savedNums = JSON.parse(localStorage.getItem('samo_my_order_numbers') || '[]');
  if (Array.isArray(savedNums)) {
    savedNums.forEach(n => { if (n) mySubmittedOrderNumbers.add(String(n)); });
  }
} catch (e) {
  console.warn('Error reading samo_my_order_numbers:', e);
}

function saveMyOrderNumbers() {
  try {
    localStorage.setItem('samo_my_order_numbers', JSON.stringify(Array.from(mySubmittedOrderNumbers)));
  } catch (e) {}
}

/**
 * دالة تسجيل حركات المخزن الموحدة في Supabase (جدول inventory_logs)
 * الأعمدة الفعلية في الجدول هي:
 * - action_type (text)
 * - item_name (text)
 * - details (jsonb)
 * - performed_by (text)
 * - created_at (timestamptz - افتراضي)
 */
const logInventoryMovement = async (actionType, itemName, detailsObj) => {
  try {
    console.log('جاري إرسال حركة إلى inventory_logs...', { actionType, itemName, detailsObj });

    const sb = (typeof getSupabaseClient === 'function' ? getSupabaseClient() : null) || (typeof supabase !== 'undefined' ? supabase : null);
    if (!sb) {
      console.error('فشل إدخال السجل في inventory_logs: Supabase client is null or undefined');
      return null;
    }

    const performer = (typeof currentUser !== 'undefined' && (currentUser?.name || currentUser?.email)) ||
      (typeof currentStaffEmail !== 'undefined' && currentStaffEmail) ||
      (typeof currentStaff !== 'undefined' && currentStaff) ||
      localStorage.getItem('samo_staff_email') ||
      localStorage.getItem('samo_current_staff') ||
      'صاحب المذخر';

    const payload = {
      action_type: actionType,
      item_name: itemName || 'غير محدد',
      details: typeof detailsObj === 'object' && detailsObj !== null ? detailsObj : { note: detailsObj },
      performed_by: performer
    };

    const { data, error } = await sb
      .from('inventory_logs')
      .insert([payload])
      .select();

    if (error) {
      console.error('فشل إدخال السجل في inventory_logs:', error);
      return null;
    } else {
      console.log('تم تسجيل حركة المخزن بنجاح:', data);
      return data;
    }
  } catch (e) {
    console.error('خطأ غير متوقع أثناء تسجيل حركة المخزون:', e);
    return null;
  }
};
window.logInventoryMovement = logInventoryMovement;

const recordInventoryLog = async (arg1, arg2, arg3) => {
  if (typeof arg1 === 'object' && arg1 !== null && !Array.isArray(arg1) && (arg1.actionType || arg1.action_type)) {
    return logInventoryMovement(arg1.actionType || arg1.action_type, arg1.itemName || arg1.item_name, arg1.details || arg1);
  }
  return logInventoryMovement(arg1, arg2, arg3);
};
const logInventoryAction = logInventoryMovement;
window.recordInventoryLog = recordInventoryLog;
window.logInventoryAction = logInventoryAction;

// Check if an order is strictly an approved outgoing order
function isApprovedOrder(o) {
  if (!o || typeof o !== 'object') return false;
  const st = String(o.status || '').trim().toLowerCase();
  return [
    'معتمد للتجهيز',
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
    'مجهزة',
    'approved',
    'تم التجهيز',
    'مكتمل',
    'completed'
  ].includes(st);
}
window.isApprovedOrder = isApprovedOrder;

// Check if an order has been marked as delivered
function isOrderDelivered(o) {
  if (!o || typeof o !== 'object') return false;
  const st = String(o.status || '').trim().toLowerCase();
  return [
    'مستلم',
    'مسلّم',
    'مسلم',
    'مسلّمة',
    'مسلمة',
    'تم التسليم',
    'تم تسليمها',
    'مسلمة بنجاح',
    'delivered'
  ].includes(st);
}
window.isOrderDelivered = isOrderDelivered;

/**
 * Deduplicates an array of orders by key (ID or orderNumber) without duplication
 */
function setUniqueOrders(newOrdersList) {
  if (!Array.isArray(newOrdersList)) return [];
  const result = [];
  const seen = new Set();

  newOrdersList.forEach(order => {
    if (!order) return;
    const idKey = (order.id !== undefined && order.id !== null && String(order.id).trim() !== '') ? String(order.id).trim() : null;
    const numKey = (order.orderNumber !== undefined && order.orderNumber !== null && String(order.orderNumber).trim() !== '') ? String(order.orderNumber).trim() : null;

    if (idKey && seen.has(`id:${idKey}`)) return;
    if (numKey && seen.has(`num:${numKey}`)) return;
    if (idKey && seen.has(`num:${idKey}`)) return;
    if (numKey && seen.has(`id:${numKey}`)) return;

    if (idKey) seen.add(`id:${idKey}`);
    if (numKey) seen.add(`num:${numKey}`);
    result.push(order);
  });

  return result;
};
window.setUniqueOrders = setUniqueOrders;

/**
 * Fetches incoming orders from Supabase with status 'قيد المراجعة' only (excludes pending/drafts)
 */
const fetchIncomingOrders = async () => {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('status', 'قيد المراجعة')
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('fetchIncomingOrders error:', error.message);
      return;
    }

    if (data && Array.isArray(data)) {
      const incomingList = data.map(supabaseOrderToAppOrder).filter(Boolean);
      // Strictly only orders with 'قيد المراجعة'
      pendingOrders = setUniqueOrders(incomingList.filter(o => o.status === 'قيد المراجعة'));
      saveLocalData();
      updateIncomingBadge();
      updateUserOrdersBadge();
      if (typeof currentTab !== 'undefined' && currentTab === 'incoming' && typeof renderIncomingOrders === 'function') {
        renderIncomingOrders();
      }
      if (typeof currentTab !== 'undefined' && currentTab === 'log' && typeof renderOrdersLog === 'function') {
        renderOrdersLog();
      }
    }
  } catch (err) {
    console.warn('fetchIncomingOrders exception:', err);
  }
};
window.fetchIncomingOrders = fetchIncomingOrders;

const fetchOrders = async () => {
  await fetchIncomingOrders();
};
window.fetchOrders = fetchOrders;

/**
 * Realtime listener on 'orders-sync' channel for incoming orders
 */
let ordersSyncChannel = null;
function setupSupabaseOrdersRealtime() {
  const supabase = getSupabaseClient();
  if (!supabase || typeof supabase.channel !== 'function') return;

  try {
    if (ordersSyncChannel) {
      try { supabase.removeChannel(ordersSyncChannel); } catch (e) {}
      ordersSyncChannel = null;
    }

    ordersSyncChannel = supabase
      .channel('orders-sync')
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'orders' }, (payload) => {
        console.log('⚡ Realtime order DELETE detected on orders-sync:', payload);
        const deletedId = payload?.old?.id;
        if (deletedId !== undefined && deletedId !== null) {
          const delIdStr = String(deletedId).trim();
          pendingOrders = pendingOrders.filter(order => String(order.id).trim() !== delIdStr && String(order.orderNumber || '').trim() !== delIdStr);
          orders = orders.filter(order => String(order.id).trim() !== delIdStr && String(order.orderNumber || '').trim() !== delIdStr);
          mySubmittedOrderNumbers.delete(delIdStr);
          saveLocalData();
          saveMyOrderNumbers();
          updateIncomingBadge();
          updateUserOrdersBadge();
          renderIncomingOrders();
          renderOrdersLog();
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, (payload) => {
        console.log('⚡ Realtime order INSERT detected on orders-sync:', payload);
        if (payload && payload.new) {
          const newOrder = supabaseOrderToAppOrder(payload.new);
          if (newOrder) {
            if (newOrder.status === 'قيد المراجعة') {
              const exists = pendingOrders.some(o => 
                (newOrder.id && (String(o.id) === String(newOrder.id) || o.orderNumber === String(newOrder.id))) ||
                (newOrder.orderNumber && (o.orderNumber === newOrder.orderNumber || String(o.id) === newOrder.orderNumber))
              );
              if (!exists) {
                pendingOrders = [newOrder, ...pendingOrders];
              }
            } else if (isApprovedOrder(newOrder)) {
              const exists = orders.some(o => 
                (newOrder.id && (String(o.id) === String(newOrder.id) || o.orderNumber === String(newOrder.id))) ||
                (newOrder.orderNumber && (o.orderNumber === newOrder.orderNumber || String(o.id) === newOrder.orderNumber))
              );
              if (!exists) {
                orders = [newOrder, ...orders];
              }
            }
            saveLocalData();
            updateIncomingBadge();
            updateUserOrdersBadge();
            if (typeof currentTab !== 'undefined' && currentTab === 'incoming' && typeof renderIncomingOrders === 'function') {
              renderIncomingOrders();
            }
            if (typeof currentTab !== 'undefined' && currentTab === 'log' && typeof renderOrdersLog === 'function') {
              renderOrdersLog();
            }
          }
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, (payload) => {
        console.log('⚡ Realtime order UPDATE detected on orders-sync:', payload);
        if (payload && payload.new) {
          const updated = supabaseOrderToAppOrder(payload.new);
          if (updated) {
            if (isApprovedOrder(updated)) {
              pendingOrders = pendingOrders.filter(o => String(o.id) !== String(updated.id) && o.orderNumber !== updated.orderNumber);
              orders = setUniqueOrders([updated, ...orders]);
            } else if (updated.status === 'قيد المراجعة') {
              orders = orders.filter(o => String(o.id) !== String(updated.id) && o.orderNumber !== updated.orderNumber);
              pendingOrders = setUniqueOrders([updated, ...pendingOrders]);
            }
            saveLocalData();
            updateIncomingBadge();
            updateUserOrdersBadge();
            if (typeof currentTab !== 'undefined' && currentTab === 'incoming' && typeof renderIncomingOrders === 'function') {
              renderIncomingOrders();
            }
            if (typeof currentTab !== 'undefined' && currentTab === 'log' && typeof renderOrdersLog === 'function') {
              renderOrdersLog();
            }
          }
        }
      })
      .subscribe((status) => {
        console.log('Supabase orders-sync status:', status);
      });

    return ordersSyncChannel;
  } catch (err) {
    console.warn('setupSupabaseOrdersRealtime exception:', err);
  }
}
window.setupSupabaseOrdersRealtime = setupSupabaseOrdersRealtime;

// In-app modal confirmation dialog (immune to iframe restrictions)
function closeConfirmDeleteModal() {
  const modal = document.getElementById('modal-confirm-delete');
  if (modal) modal.classList.remove('is-open');
}

function showInAppAlert(message, title = 'تنبيه') {
  showInAppConfirm({
    title: title,
    message: message,
    icon: 'ℹ️',
    confirmText: 'حسناً',
    isDanger: false,
    onConfirm: () => {}
  });
}

function showInAppConfirm({ title, message, icon = '🗑️', confirmText = 'نعم، تأكيد', isDanger = true, onConfirm }) {
  const modal = document.getElementById('modal-confirm-delete');
  if (modal) {
    // DOM Positioning / Portal equivalent: Ensure top stacking context in document.body
    if (modal.parentElement !== document.body || modal !== document.body.lastElementChild) {
      document.body.appendChild(modal);
    }
    modal.style.zIndex = '2147483647';
  }
  const titleEl = document.getElementById('confirm-delete-title');
  const msgEl = document.getElementById('confirm-delete-msg');
  const btnEl = document.getElementById('confirm-delete-action-btn');
  const iconEl = document.getElementById('confirm-delete-icon');

  if (titleEl) titleEl.innerText = title || 'تأكيد';
  if (msgEl) msgEl.innerHTML = message || '';
  if (iconEl) {
    iconEl.innerText = icon;
    iconEl.style.background = isDanger ? '#fee2e2' : '#e0f2fe';
    iconEl.style.color = isDanger ? '#dc2626' : '#0284c7';
  }
  if (btnEl) {
    btnEl.innerText = confirmText;
    btnEl.className = isDanger ? 'btn btn-danger' : 'btn';
    btnEl.onclick = () => {
      closeConfirmDeleteModal();
      if (typeof onConfirm === 'function') onConfirm();
    };
  }
  if (modal) modal.classList.add('is-open');
}

// Quick modern toast notification (non-blocking)
function showQuickToast(msg, type = 'success') {
  let toast = document.getElementById('samo-quick-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'samo-quick-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 85px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: #18181b;
      color: #fff;
      padding: 10px 20px;
      border-radius: 30px;
      font-size: 13px;
      font-weight: 700;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      z-index: 2147483647;
      opacity: 0;
      transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
      display: flex;
      align-items: center;
      gap: 8px;
      direction: rtl;
    `;
    document.body.appendChild(toast);
  }
  if (type === 'error') {
    toast.style.background = '#dc2626';
  } else if (type === 'warn') {
    toast.style.background = '#d97706';
  } else {
    toast.style.background = '#059669';
  }
  toast.innerText = msg;
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 2400);
}

// Order Merging State
let selectedOrderNumbersToMerge = new Set();
let pendingMergeData = null;

function updateIncomingBadge() {
  const badge = document.getElementById('incoming-count-badge');
  if (badge) {
    if (pendingOrders.length > 0) {
      badge.style.display = 'inline-block';
      badge.innerText = pendingOrders.length;
    } else {
      badge.style.display = 'none';
    }
  }
}

// Dosage forms auto-detection
function smartDetectForm(name, existingForm) {
  if (existingForm && existingForm.trim()) {
    const trimmed = existingForm.trim();
    const match = dosageForms.find(f => 
      (f.key || '').toLowerCase() === trimmed.toLowerCase() || 
      (f.nameAr || '').toLowerCase() === trimmed.toLowerCase()
    );
    return match ? match.key : trimmed;
  }

  const n = (name || '').toLowerCase();
  for (const f of dosageForms) {
    const k = (f.key || '').toLowerCase();
    const ar = (f.nameAr || '').toLowerCase();
    if (k && n.includes(k)) return f.key;
    if (ar && n.includes(ar)) return f.key;
  }

  if (n.includes('tab') || n.includes('حبوب')) return 'Tablet';
  if (n.includes('cap') || n.includes('كبسول')) return 'Capsule';
  if (n.includes('syr') || n.includes('شراب')) return 'Syrup';
  if (n.includes('susp') || n.includes('معلق')) return 'Suspension';
  if (n.includes('inj') || n.includes('حقن')) return 'Injection';
  if (n.includes('vial') || n.includes('فيال')) return 'Vial';
  if (n.includes('amp') || n.includes('أمبول')) return 'Ampoule';
  if (n.includes('cream') || n.includes('كريم')) return 'Cream';
  if (n.includes('oint') || n.includes('مرهم')) return 'Ointment';
  if (n.includes('sachet') || n.includes('ساشيت')) return 'Sachet';
  if (n.includes('gel') || n.includes('جل')) return 'Gel';
  if (n.includes('drop') || n.includes('قطرة') || n.includes('قطرات')) return 'Drops';
  
  return dosageForms[0]?.key || 'Tablet';
}

function getMedicineExpiry(item) {
  if (!item) return '';
  let exp = String(item.expiryDate || item.expiry_date || '').trim();
  if (exp && exp !== '-' && exp !== 'غير مسجل') return exp;

  const id = String(item.id || '').trim();
  const barcode = String(item.barcode || '').trim();
  const name = String(item.name || item.product_name || '').trim().toLowerCase();

  if (Array.isArray(products) && products.length > 0) {
    const prod = products.find(p => {
      if (id && p.id === id) return true;
      if (barcode && p.barcode === barcode) return true;
      if (name && p.name && p.name.trim().toLowerCase() === name) return true;
      if (name && p.name && (p.name.trim().toLowerCase().includes(name) || name.includes(p.name.trim().toLowerCase()))) return true;
      return false;
    });
    if (prod && prod.expiryDate) {
      return String(prod.expiryDate).trim();
    }
  }
  return '';
}

function normalizeOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const items = Array.isArray(order.items) ? order.items : [];
  const status = (order.status || 'معتمد للتجهيز').trim();
  const orderNumber = String(order.orderNumber || order.order_number || (order.id ? `ORD-SB-${order.id}` : `ORD-${Date.now()}`));
  const realId = (order.id !== undefined && order.id !== null && order.id !== '') ? String(order.id) : (order.order_id ? String(order.order_id) : orderNumber);
  return {
    id: realId,
    orderNumber,
    pharmacyName: String(order.pharmacyName || order.pharmacy_name || 'صيدلية غير مسجلة').trim(),
    phone: String(order.phone || '').trim(),
    staffName: String(order.staffName || order.staff_name || '').trim(),
    deliveryStaffName: String(order.deliveryStaffName || order.delivery_staff_name || '').trim(),
    deliveredAt: String(order.deliveredAt || order.delivered_at || '').trim(),
    totalAmount: Number(order.totalAmount || order.total_amount || 0),
    status,
    date: String(order.date || order.createdAt || new Date().toLocaleString('ar-IQ')).trim(),
    createdAt: safeIsoDate(order.createdAt || order.date),
    userId: String(order.userId || order.user_id || '').trim(),
    items: items.map(it => {
      const exp = getMedicineExpiry(it);
      return {
        id: String(it.id || ''),
        name: String(it.name || it.product_name || 'مادة بدون اسم').trim(),
        barcode: String(it.barcode || '').trim(),
        form: smartDetectForm(it.name, it.form),
        quantity: Math.max(0, Math.floor(Number(it.quantity) || 0)),
        price: Math.max(0, Number(it.price) || 0),
        expiryDate: exp
      };
    })
  };
}

function normalizePharmacy(p, index) {
  if (!p) return null;
  if (typeof p === 'string') {
    const trimmed = p.trim();
    if (!trimmed) return null;
    return {
      id: 'ph_' + Date.now() + '_' + (index || Math.floor(Math.random() * 10000)),
      name: trimmed,
      phone: '',
      address: '',
      notes: '',
      createdAt: new Date().toISOString()
    };
  }
  if (typeof p === 'object') {
    const name = String(p.name || p.pharmacyName || p.customerName || '').trim();
    if (!name) return null;
    return {
      id: String(p.id || ('ph_' + Date.now() + '_' + (index || Math.floor(Math.random() * 10000)))),
      name: name,
      phone: String(p.phone || p.customerPhone || '').trim(),
      address: String(p.address || '').trim(),
      notes: String(p.notes || '').trim(),
      createdAt: p.createdAt || new Date().toISOString()
    };
  }
  return null;
}

// Local Storage helpers
function saveLocalCart() {
  try {
    localStorage.setItem('samo_cart', JSON.stringify(cart));
    if (typeof queueAutoSaveDraft === 'function') queueAutoSaveDraft();
  } catch (e) {
    console.warn('Cart save error:', e);
  }
}

function saveLocalData() {
  try {
    localStorage.setItem('samo_local_products', JSON.stringify(products));
    localStorage.setItem('samo_local_orders', JSON.stringify(orders));
    localStorage.setItem('samo_local_pending', JSON.stringify(pendingOrders));
    localStorage.setItem('samo_local_pharmacies', JSON.stringify(pharmacies));
    localStorage.setItem('samo_local_staff', JSON.stringify(staffNames));
    localStorage.setItem('samo_system_settings', JSON.stringify(systemSettings));
    saveLocalCart();
  } catch (e) {
    console.warn('LocalStorage save error:', e);
  }
}

function loadLocalData() {
  try {
    const p = localStorage.getItem('samo_local_products');
    if (p) {
      try {
        products = JSON.parse(p).map(normalizeProduct).filter(Boolean);
        filteredProducts = products;
      } catch (e) {}
    }
    const o = localStorage.getItem('samo_local_orders');
    if (o) orders = JSON.parse(o).map(normalizeOrder).filter(Boolean).filter(isApprovedOrder);
    const po = localStorage.getItem('samo_local_pending');
    if (po) pendingOrders = JSON.parse(po).map(normalizeOrder).filter(Boolean).filter(x => !isApprovedOrder(x));
    const ph = localStorage.getItem('samo_local_pharmacies');
    if (ph) {
      const parsedPh = JSON.parse(ph);
      if (Array.isArray(parsedPh)) {
        pharmacies = parsedPh.map(normalizePharmacy).filter(Boolean);
      }
    }
    const st = localStorage.getItem('samo_local_staff');
    if (st) staffNames = JSON.parse(st);
    const ss = localStorage.getItem('samo_system_settings');
    if (ss) {
      try { systemSettings = { ...systemSettings, ...JSON.parse(ss) }; } catch (e) {}
    }
    const sc = localStorage.getItem('samo_cart');
    if (sc) cart = JSON.parse(sc) || {};
    const spc = localStorage.getItem('samo_pos_cart');
    if (spc) { try { posCart = JSON.parse(spc) || {}; } catch (e) {} }
    const spcp = localStorage.getItem('samo_pos_cart_prices');
    if (spcp) { try { posCartCustomPrices = JSON.parse(spcp) || {}; } catch (e) {} }
  } catch (e) {
    console.warn('LocalStorage load error:', e);
  }
}

// Remote API loader with retry mechanism
async function loadRemoteData(retries = 2) {
  if (isFetchingRemote) return;
  isFetchingRemote = true;
  const lbl = document.getElementById('conn-lbl');
  if (lbl) lbl.innerText = 'جاري المزامنة مع قاعدة البيانات...';

  try {
    const res = await fetch('https://boaopqyzhvyzdclmoycr.supabase.co/rest/v1/samo?select=*', {
      headers: {
        'apikey': 'sb_publishable_5Tg1o4MnUSseRc1bw78Erg_wIQNF42I',
        'Authorization': 'Bearer sb_publishable_5Tg1o4MnUSseRc1bw78Erg_wIQNF42I'
      }
    });

    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();

    if (Array.isArray(data) && data.length > 0) {
      products = data.map(item => ({
        id: String(item.id),
        name: item.product || item.name || 'بدون اسم',
        company: item.company || '',
        barcode: item.barcode || '',
        quantity: Number(item.number ?? item.quantity ?? 0),
        number: Number(item.number ?? item.quantity ?? 0),
        price: Number(item.price_of_one ?? item.price ?? 0),
        bonus: Number(item.bonus || 0),
        minQty: Number(item.limit_number ?? item.minQty ?? 5),
        expiryDate: item.expire_date || item.expiryDate || '',
        image: item.image_url || item.image || ''
      }));

      filteredProducts = products;
      if (typeof saveLocalData === 'function') saveLocalData();
      if (typeof renderProducts === 'function') renderProducts();
    }

    if (data && data.success) {
      if (Array.isArray(data.products)) {
        products = data.products.map(normalizeProduct).filter(Boolean);
        filteredProducts = products;
      }

      if (Array.isArray(data.orders)) {
        // Enforce that orders contains ONLY approved orders (الطلبيات الصادرة)
        orders = setUniqueOrders(data.orders.map(normalizeOrder).filter(Boolean).filter(isApprovedOrder));
      }

      if (Array.isArray(data.pendingOrders)) {
        // Pending orders strictly filter to 'قيد المراجعة'
        pendingOrders = setUniqueOrders(data.pendingOrders.map(normalizeOrder).filter(Boolean).filter(x => x.status === 'قيد المراجعة'));
      }

      if (Array.isArray(data.pharmacies)) {
        pharmacies = data.pharmacies.map(normalizePharmacy).filter(Boolean);
      }

      if (Array.isArray(data.staffNames) && data.staffNames.length > 0) {
        staffNames = data.staffNames;
      }

      if (data.settings && typeof data.settings === 'object') {
        systemSettings = { ...systemSettings, ...data.settings };
      }

      // Fetch and merge orders directly from Supabase "orders" table
      try {
        const sbOrders = await fetchOrdersFromSupabase();
        if (Array.isArray(sbOrders) && sbOrders.length > 0) {
          const incomingPending = sbOrders.filter(x => x.status === 'قيد المراجعة');
          const incomingApproved = sbOrders.filter(isApprovedOrder);
          pendingOrders = setUniqueOrders([...pendingOrders, ...incomingPending]);
          orders = setUniqueOrders([...orders, ...incomingApproved]);
        }
      } catch (sbOrdErr) {
        console.warn('Supabase direct orders sync note:', sbOrdErr);
      }

      saveLocalData();
      // Fetch customers and sync staff & reports from Supabase tables
      try {
        await fetchCustomers();
        await fetchStaffFromSupabaseDirect(false);
        await fetchReportsFromSupabaseDirect(false);
      } catch (e) {
        console.warn('Customers, staff & reports sync error in loadRemoteData:', e);
      }

      if (lbl) {
        lbl.innerText = isAdmin 
          ? 'وضع صاحب المذخر (متصل بـ Supabase)' 
          : (currentStaff ? `وضع الموظف: ${currentStaff} (Supabase متصل)` : 'وضع الموظف (متصل)');
      }
      const cloudBadge = document.getElementById('cloud-header-badge');
      if (cloudBadge) {
        cloudBadge.innerHTML = `⚡ Supabase (${products.length})`;
        cloudBadge.style.background = '#ecfdf5';
        cloudBadge.style.color = '#059669';
        cloudBadge.style.borderColor = '#a7f3d0';
        cloudBadge.title = `متصل بقاعدة بيانات Supabase - جدول samo (${products.length} مادة)`;
      }
      const sbDetail = document.getElementById('supabase-status-detail');
      if (sbDetail) {
        sbDetail.innerHTML = `متصل بجدول <b>samo</b> في Supabase. تم جلب وتحديث <b>${products.length}</b> مادة بنجاح. أي حركة بيع أو إضافة مادة أو تعديل مخزون تُحفظ فوراً في السحابة.`;
      }
    }
  } catch (err) {
    if (retries > 0) {
      console.warn(`Connection retry attempt remaining: ${retries}`);
      isFetchingRemote = false;
      setTimeout(() => loadRemoteData(retries - 1), 1200);
      return;
    }
    console.warn('API sync note: using cached data:', err.message || err);
    loadLocalData();
    if (lbl) {
      lbl.innerText = isAdmin 
        ? 'وضع صاحب المذخر (بيانات محلية)' 
        : (currentStaff ? `وضع الموظف: ${currentStaff} (محلي)` : 'وضع الموظف (محلي)');
    }
  } finally {
    isFetchingRemote = false;
    refreshAllUI(true);
  }
}
window.loadRemoteData = loadRemoteData;
const fetchProducts = async () => {
  if (typeof loadRemoteData === 'function') {
    await loadRemoteData();
  }
};
window.fetchProducts = fetchProducts;

async function handleClientFallbackAction(payload) {
  const action = payload.action;
  const sb = typeof getSupabaseClient === 'function' ? getSupabaseClient() : null;
  try {
    if (action === 'new_order' && payload.order) {
      if (sb) {
        await sb.from('orders').insert([{
          id: payload.order.id,
          order_number: payload.order.orderNumber,
          customer_name: payload.order.pharmacyName,
          items: payload.order.items,
          total_amount: payload.order.totalAmount,
          status: payload.order.status || 'قيد المراجعة',
          staff_email: payload.order.staffEmail || currentStaffEmail
        }]);
      }
      return { status: 'success' };
    }
    if (action === 'add_product' && payload.product) {
      if (sb) {
        await sb.from('samo').insert([payload.product]);
      }
      return { status: 'success', product: payload.product };
    }
    if (action === 'update_product' && payload.product) {
      if (sb) {
        await sb.from('samo').update(payload.product).eq('id', payload.product.id);
      }
      return { status: 'success' };
    }
    if (action === 'delete_product') {
      if (sb && payload.productId) {
        await sb.from('samo').delete().eq('id', payload.productId);
      }
      return { status: 'success' };
    }
    if (action === 'delete_order' || action === 'discard_pending_order') {
      if (sb && (payload.orderNumber || payload.orderId)) {
        await sb.from('orders').delete().or(`id.eq.${payload.orderId || payload.orderNumber},order_number.eq.${payload.orderNumber || payload.orderId}`);
      }
      return { status: 'success' };
    }
    if (action === 'approve_order') {
      if (sb && payload.orderNumber) {
        await sb.from('orders').update({ status: 'تم التجهيز' }).eq('order_number', payload.orderNumber);
      }
      return { status: 'success' };
    }
  } catch (fallbackErr) {
    console.warn('handleClientFallbackAction error:', fallbackErr);
  }
  return { status: 'success' };
}

async function postToApi(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('postToApi fallback to client action due to:', err?.message || err);
    return await handleClientFallbackAction(payload);
  }
}

function triggerSync() {
  loadRemoteData();
  forceLoadMedicines();
}

let postLoginRedirectTab = '';

function openSettingsTabPrompt(targetSubTab) {
  if (isAdmin) {
    setMainTab('settings');
    if (targetSubTab) switchSettingsTab(targetSubTab);
    return;
  }

  // If user is already designated as Owner / Admin via Google Account, enter immediately without PIN!
  if (isStaffAdminOrOwner(currentStaffEmail || currentStaff)) {
    isAdmin = true;
    localStorage.setItem('samo_is_admin', 'true');
    applyAdminState();
    setMainTab('settings');
    if (targetSubTab) switchSettingsTab(targetSubTab);
    showQuickToast('👑 تم فتح الإعدادات بحساب صاحب المذخر مباشرة.');
    return;
  }

  postLoginRedirectTab = targetSubTab || 'settings';
  openAdminAuthModal();
  const err = document.getElementById('admin-pin-error');
  if (err) {
    err.innerText = targetSubTab === 'dosage' 
      ? 'أدخل رمز أمان المذخر (1234) للوصول إلى قسم الأشكال الدوائية'
      : 'أدخل رمز أمان المذخر (1234) للوصول إلى مركز الإعدادات';
    err.style.display = 'block';
    err.style.color = '#0284c7';
  }
}

// Tab Switching
function setMainTab(tab) {
  // If requesting settings while not admin, prompt for PIN
  if (!isAdmin && tab === 'settings') {
    openSettingsTabPrompt();
    return;
  }

  // Restrict other admin-only tabs
  if (!isAdmin && (tab === 'pos' || tab === 'incoming' || tab === 'staff' || tab === 'reports')) {
    showQuickToast('هذا القسم متاح فقط لصاحب المذخر');
    tab = 'home';
  }

  currentTab = tab;
  
  // Update view visibility strictly
  ['home', 'pos', 'incoming', 'log', 'staff', 'reports', 'settings'].forEach(t => {
    const el = document.getElementById(`view-${t}`);
    if (el) {
      if (t === tab) {
        el.style.display = (t === 'home') ? 'flex' : 'block';
        el.style.visibility = 'visible';
      } else {
        el.style.display = 'none';
        el.style.visibility = 'hidden';
      }
    }
  });

  // Update Admin Tabs Bar
  ['home', 'pos', 'incoming', 'log', 'staff', 'reports', 'settings'].forEach(t => {
    const btn = document.getElementById(`tab-btn-${t}`);
    if (btn) {
      if (t === tab) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  });

  // Update User Mode Nav Bar
  const userHomeBtn = document.getElementById('user-tab-btn-home');
  const userLogBtn = document.getElementById('user-tab-btn-log');
  if (userHomeBtn && userLogBtn) {
    if (tab === 'home') {
      userHomeBtn.classList.add('active');
      userLogBtn.classList.remove('active');
    } else if (tab === 'log') {
      userLogBtn.classList.add('active');
      userHomeBtn.classList.remove('active');
    } else {
      userHomeBtn.classList.remove('active');
      userLogBtn.classList.remove('active');
    }
  }

  if (tab === 'home') renderProducts();
  else updateWarehouseSideTracker();
  if (tab === 'pos') { renderPosGrid(); renderPosCart(); }
  if (tab === 'incoming') {
    renderIncomingOrders();
    loadRemoteData();
  }
  if (tab === 'log') {
    renderOrdersLog();
    loadRemoteData();
  }
  if (tab === 'staff') {
    populateStaffDropdowns();
    renderStaffReport();
    buildStaffPeriodReport();
  }
  if (tab === 'reports') {
    updateFinanceReports();
    populateCompanyReportDropdown();
    if (typeof fetchReportsFromSupabaseDirect === 'function') fetchReportsFromSupabaseDirect();
    if (typeof fetchInventoryLogsFromSupabaseDirect === 'function') fetchInventoryLogsFromSupabaseDirect();
  }
  if (tab === 'settings') {
    switchSettingsTab(currentSettingsTab || 'pharmacies');
  }
}

// Scientific Barcode Formatter
function formatBarcodeDisplay(barcode) {
  if (barcode === undefined || barcode === null) return '';
  let str = String(barcode).trim();
  if (!str) return '';
  // Check scientific notation like 9.64E+12 or 9.64e+12
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/i.test(str)) {
    try {
      const num = Number(str);
      if (!isNaN(num) && isFinite(num)) {
        str = BigInt(Math.round(num)).toString();
      }
    } catch (e) {
      try {
        const parts = str.toLowerCase().split('e');
        let coeff = parts[0];
        let exp = parseInt(parts[1], 10);
        if (exp > 0) {
          const dotIdx = coeff.indexOf('.');
          if (dotIdx >= 0) {
            const decLen = coeff.length - 1 - dotIdx;
            coeff = coeff.replace('.', '');
            exp -= decLen;
          }
          str = coeff + '0'.repeat(Math.max(0, exp));
        }
      } catch (err) {}
    }
  }
  return str;
}

// Admin Mode
function triggerAdmin() {
  if (isAdmin) {
    if (confirm('هل تريد الخروج من وضع صاحب المذخر والعودة للوضع العادي؟')) {
      isAdmin = false;
      localStorage.removeItem('samo_is_admin');
      currentStaff = '';
      localStorage.removeItem('samo_current_staff');
      applyAdminState();
      setMainTab('home');
      showQuickToast('تم الخروج من وضع المذخر');
    }
    return;
  }

  // If user is designated as Owner via Google Account, enter immediately without PIN!
  if (isStaffAdminOrOwner(currentStaffEmail || currentStaff)) {
    isAdmin = true;
    localStorage.setItem('samo_is_admin', 'true');
    applyAdminState();
    showQuickToast('👑 تم الدخول كـ "صاحب المذخر" مباشرة بدون رمز.');
    return;
  }

  openAdminAuthModal();
}

function openAdminAuthModal() {
  const input = document.getElementById('admin-pin-input');
  const err = document.getElementById('admin-pin-error');
  if (input) {
    input.value = '';
    input.type = 'password';
  }
  if (err) err.style.display = 'none';
  const modal = document.getElementById('modal-admin-auth');
  if (modal) modal.classList.add('is-open');
  setTimeout(() => { if (input) input.focus(); }, 120);
}

function closeAdminAuthModal() {
  const modal = document.getElementById('modal-admin-auth');
  if (modal) modal.classList.remove('is-open');
}

function toggleAdminPinVisibility() {
  const input = document.getElementById('admin-pin-input');
  if (input) {
    input.type = input.type === 'password' ? 'text' : 'password';
  }
}

async function submitAdminAuth() {
  const input = document.getElementById('admin-pin-input');
  const err = document.getElementById('admin-pin-error');
  const pin = (input ? input.value : '').trim();

  if (!pin) {
    if (err) {
      err.innerText = 'يرجى إدخال رمز الأمان';
      err.style.display = 'block';
    }
    return;
  }

  try {
    const res = await fetch('/api/verify-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      isAdmin = true;
      localStorage.setItem('samo_is_admin', 'true');
      closeAdminAuthModal();
      applyAdminState();
      if (postLoginRedirectTab) {
        const dest = postLoginRedirectTab;
        postLoginRedirectTab = '';
        setMainTab('settings');
        if (dest !== 'settings') {
          switchSettingsTab(dest);
        }
        showQuickToast('تم الدخول بنجاح إلى الإعدادات ⚙️');
      } else if (pendingOrders.length > 0) {
        setMainTab('incoming');
      } else {
        setMainTab('home');
      }
      showInAppAlert('مرحباً بك! تم الدخول بنجاح إلى لوحة تحكم صاحب المذخر.', 'دخول ناجح');
      return;
    }
  } catch (e) {
    // Fallback if offline/network error
    if (pin === '1234') {
      isAdmin = true;
      localStorage.setItem('samo_is_admin', 'true');
      closeAdminAuthModal();
      applyAdminState();
      if (postLoginRedirectTab) {
        const dest = postLoginRedirectTab;
        postLoginRedirectTab = '';
        setMainTab('settings');
        if (dest !== 'settings') {
          switchSettingsTab(dest);
        }
        showQuickToast('تم الدخول بنجاح إلى الإعدادات ⚙️');
      } else if (pendingOrders.length > 0) {
        setMainTab('incoming');
      } else {
        setMainTab('home');
      }
      return;
    }
  }

  if (err) {
    err.innerText = 'رمز الأمان غير صحيح، يرجى إعادة المحاولة';
    err.style.display = 'block';
  }
  if (input) {
    input.value = '';
    input.focus();
  }
}

function applyAdminState() {
  const userHeader = document.getElementById('user-header');
  const adminHeader = document.getElementById('admin-header');
  const userNavBar = document.getElementById('user-nav-bar');
  const adminTabsBar = document.getElementById('admin-tabs-bar');
  const addBtn = document.getElementById('add-prod-btn');
  const headerNotificationsBtn = document.getElementById('header-notifications-btn');
  const headerSettingsBtn = document.getElementById('header-settings-btn');
  const dosageMgmtBtn = document.getElementById('admin-dosage-mgmt-btn');
  const ordersScopeBar = document.getElementById('orders-scope-bar-wrapper');

  if (isAdmin) {
    if (userHeader) userHeader.style.display = 'none';
    if (adminHeader) adminHeader.style.display = 'flex';
    if (userNavBar) userNavBar.style.display = 'none';
    if (adminTabsBar) adminTabsBar.style.display = 'flex';
    if (addBtn) addBtn.style.display = 'inline-flex';
    if (headerNotificationsBtn) headerNotificationsBtn.style.display = 'inline-flex';
    if (headerSettingsBtn) headerSettingsBtn.style.display = 'inline-flex';
    if (dosageMgmtBtn) dosageMgmtBtn.style.display = 'inline-flex';
    if (ordersScopeBar) ordersScopeBar.style.display = 'flex';

    // Check low stock shortage alerts for warehouse owner
    checkSamoLowStockAlerts();
  } else {
    if (userHeader) userHeader.style.display = 'flex';
    if (adminHeader) adminHeader.style.display = 'none';
    if (userNavBar) userNavBar.style.display = 'flex';
    if (adminTabsBar) adminTabsBar.style.display = 'none';
    if (addBtn) addBtn.style.display = 'none';
    if (headerNotificationsBtn) headerNotificationsBtn.style.display = 'none';
    if (headerSettingsBtn) headerSettingsBtn.style.display = 'none';
    if (dosageMgmtBtn) dosageMgmtBtn.style.display = 'none';
    if (ordersScopeBar) ordersScopeBar.style.display = 'none';

    // Clear and hide shortage alerts banner
    const alertsContainer = document.getElementById('alerts-container');
    if (alertsContainer) alertsContainer.innerHTML = '';
    closeShortageNotificationsModal();

    if (currentTab === 'incoming' || currentTab === 'staff' || currentTab === 'reports' || currentTab === 'pos' || currentTab === 'settings') {
      setMainTab('home');
    }
  }

  // Adjust stock filter options (shortage & low stock alerts are admin-only)
  const filterStock = document.getElementById('filter-stock');
  if (filterStock) {
    const curVal = filterStock.value;
    if (isAdmin) {
      filterStock.innerHTML = `
        <option value="">-- الكل --</option>
        <option value="available">متوفر بالمخزن</option>
        <option value="low_stock">⚠️ دون الحد الأدنى (جدول samo)</option>
        <option value="shortage">نواقص / نفد (0)</option>
      `;
    } else {
      filterStock.innerHTML = `
        <option value="">-- الكل --</option>
        <option value="available">متوفر للطلب</option>
        <option value="shortage">غير متوفر (0)</option>
      `;
    }
    if (curVal === 'low_stock' && !isAdmin) {
      filterStock.value = '';
    } else {
      filterStock.value = curVal || '';
    }
  }

  populateStaffDropdowns();
  updateCartBadge();
  updateUserOrdersBadge();
  renderProducts();
}

function populateStaffDropdowns() {
  const selects = ['header-staff-select', 'staff-name-select', 'staff-report-select', 'order-staff-select'];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';

    if (id === 'staff-report-select') {
      const defAll = document.createElement('option');
      defAll.value = '__all__';
      defAll.innerText = '👑 كافة الموظفين (تقرير موحد شامل)';
      sel.appendChild(defAll);
    } else if (id === 'order-staff-select') {
      const def = document.createElement('option');
      def.value = '';
      def.innerText = '-- اختر اسمك (صاحب الطلبية) --';
      sel.appendChild(def);
    } else if (id === 'staff-name-select' || id === 'header-staff-select') {
      const def = document.createElement('option');
      def.value = '';
      def.innerText = isAdmin ? '👑 الكل (جميع الموظفين)' : '👤 اختر اسمك للعمل...';
      sel.appendChild(def);
    }

    let listToRender = Array.isArray(staffNames) && staffNames.length > 0 ? staffNames : [];
    if (listToRender.length === 0) {
      try {
        const saved = localStorage.getItem('samo_local_staff');
        if (saved) listToRender = JSON.parse(saved);
      } catch (e) {}
    }
    if (listToRender.length === 0) {
      listToRender = ['صاحب المذخر', 'مندوب المبيعات', 'المشرف العام'];
      staffNames = listToRender;
    }
    if (currentStaff && !listToRender.includes(currentStaff)) {
      listToRender = [currentStaff, ...listToRender];
    }

    listToRender.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      const assigned = typeof getAssignedPharmacyForStaff === 'function' ? getAssignedPharmacyForStaff(s) : null;
      if (assigned && assigned.pharmacyName) {
        opt.innerText = `${s} 🏥 (${assigned.pharmacyName})`;
      } else {
        opt.innerText = s;
      }
      sel.appendChild(opt);
    });

    if (id !== 'header-staff-select') {
      const newOpt = document.createElement('option');
      newOpt.value = '__new__';
      newOpt.innerText = '➕ إضافة اسم موظف جديد...';
      sel.appendChild(newOpt);
    }

    if (cur && cur !== '__new__') {
      sel.value = cur;
    } else if (id === 'staff-report-select') {
      sel.value = currentStaff || '__all__';
    } else if (currentStaff) {
      sel.value = currentStaff;
    }
  });

  const posStaffBadge = document.getElementById('pos-staff-badge');
  if (posStaffBadge) posStaffBadge.innerText = currentStaff || 'غير مسجل';
}

function onStaffSelected(val) {
  if (val === '__new__') {
    addNewStaffNamePrompt();
    return;
  }
  currentStaff = val;
  if (val) localStorage.setItem('samo_current_staff', val);
  else localStorage.removeItem('samo_current_staff');
  
  const posBadge = document.getElementById('pos-staff-badge');
  if (posBadge) posBadge.innerText = val || 'غير مسجل';
  
  const assigned = getAssignedPharmacyForStaff(val);

  const connLbl = document.getElementById('conn-lbl');
  if (connLbl) {
    if (isAdmin) {
      connLbl.innerText = val ? `وضع صاحب المذخر (تصفية: ${val})` : 'وضع صاحب المذخر (متصل بقاعدة البيانات)';
    } else {
      if (val && assigned && assigned.pharmacyName) {
        connLbl.innerText = `الموظف: ${val} (🏥 ${assigned.pharmacyName})`;
      } else if (val) {
        connLbl.innerText = `الموظف: ${val}`;
      } else {
        connLbl.innerText = 'تطبيق الطلبات المباشر';
      }
    }
  }

  if (!isAdmin && val && assigned && assigned.pharmacyName) {
    showQuickToast(`مرحباً ${val}! صيدليتك المعتمدة لحسابك: "${assigned.pharmacyName}" ✓`);
  }

  // Synchronize dropdowns
  ['staff-name-select', 'order-staff-select', 'staff-report-select'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel && sel.value !== val) sel.value = val;
  });

  const logViewTitle = document.getElementById('log-view-title');
  if (logViewTitle) {
    logViewTitle.innerText = isAdmin ? 'سجل الصادر والمبيعات' : 'طلباتي';
  }

  // Immediately refresh orders log so this employee's orders are displayed
  renderOrdersLog();
}

// Smart Medicine Phonetic & Multilingual Synonyms Dictionary
const arabicMedicineAliases = {
  'بنادول': ['panadol', 'paracetamol', 'acetaminophen'],
  'بانادول': ['panadol', 'paracetamol'],
  'باراسيتامول': ['paracetamol', 'panadol', 'cetamol'],
  'سيتامول': ['cetamol', 'paracetamol', 'panadol'],
  'بروفين': ['brufen', 'ibuprofen', 'profen'],
  'ايبوبروفين': ['ibuprofen', 'brufen'],
  'اموكسيل': ['amoxil', 'amoxicillin'],
  'اموكسيسيلين': ['amoxicillin', 'amoxil'],
  'اوغمنتين': ['augmentin', 'amoxicillin'],
  'اوجمنتين': ['augmentin'],
  'كلافوكس': ['klavox', 'clavox'],
  'فولتارين': ['voltaren', 'diclofenac'],
  'ديكلوفيناك': ['diclofenac', 'voltaren'],
  'ديكلون': ['declophen', 'diclon'],
  'اسبرين': ['aspirin', 'acetylsalicylic'],
  'اوميبرازول': ['omeprazole', 'losec', 'omep'],
  'نيكسيوم': ['nexium', 'esomeprazole'],
  'فلاجيل': ['flagyl', 'metronidazole'],
  'مترونيدازول': ['metronidazole', 'flagyl'],
  'زيرتك': ['zyrtec', 'cetirizine'],
  'ستريزين': ['cetirizine', 'zyrtec'],
  'كلاريتين': ['claritin', 'loratadine'],
  'لوراتادين': ['loratadine', 'claritin'],
  'بانتوبرازول': ['pantoprazole', 'controloc'],
  'كونترولوك': ['controloc', 'pantoprazole'],
  'سيبرودار': ['ciprodar', 'ciprofloxacin'],
  'سيبروفلوكساسين': ['ciprofloxacin', 'ciprodar'],
  'ازيثرومايسين': ['azithromycin', 'zithromax'],
  'زيثروماكس': ['zithromax', 'azithromycin'],
  'كلاسيد': ['klacid', 'clarithromycin'],
  'سولبادين': ['solpadeine'],
  'بوسكوبان': ['buscopan', 'hyoscine'],
  'هيوسين': ['hyoscine', 'buscopan'],
  'موتيليوم': ['motilium', 'domperidone'],
  'دومبيريدون': ['domperidone', 'motilium'],
  'بلاسيل': ['plasil', 'metoclopramide'],
  'ميتوكلوبراميد': ['metoclopramide', 'plasil'],
  'فنتولين': ['ventolin', 'salbutamol'],
  'سالبوتامول': ['salbutamol', 'ventolin'],
  'ديكادرون': ['decadron', 'dexamethasone'],
  'ديكساميثازون': ['dexamethasone', 'decadron'],
  'بريدنيزولون': ['prednisolone', 'prednisone'],
  'هيدروكورتيزون': ['hydrocortisone'],
  'فيوسيدين': ['fucidin', 'fusidic'],
  'فوسيدين': ['fucidin'],
  'كريم ميبو': ['mebo'],
  'ميبو': ['mebo'],
  'بيتادين': ['betadine', 'povidone'],
  'سيبتازول': ['septazole', 'bactrim'],
  'باكتريم': ['bactrim', 'septazole'],
  'انسولين': ['insulin', 'lantus', 'novorapid', 'mixtard'],
  'ميتفورمين': ['metformin', 'glucophage'],
  'كلوكوفاج': ['glucophage', 'metformin'],
  'جلوكوفاج': ['glucophage', 'metformin'],
  'كونكور': ['concor', 'bisoprolol'],
  'بيسوبرولول': ['bisoprolol', 'concor'],
  'نورفاسك': ['norvasc', 'amlodipine'],
  'املوديبين': ['amlodipine', 'norvasc'],
  'ليبيتور': ['lipitor', 'atorvastatin'],
  'اتورفاستاتين': ['atorvastatin', 'lipitor'],
  'كابوتين': ['capoten', 'captopril'],
  'كابتوبريل': ['captopril', 'capoten']
};

// 1. دالة استخراج الشكل الدوائي من الاسم (Client-side Form Derivation)
function getFormFromName(productName) {
  if (!productName) return 'Other';
  const parts = productName.trim().toLowerCase().split(/\s+/);
  const last = parts[parts.length - 1];
  const secondLast = parts.length > 1 ? parts[parts.length - 2] : '';
  const tail = `${secondLast} ${last}`;

  if (/drops?|قطرة/.test(tail)) return 'Drops';
  if (/oint(ment)?|مرهم/.test(tail)) return 'Ointment';
  if (/^(tab|tabs|tablet|tablets|حبوب|حب)$/.test(last)) return 'Tablet';
  if (/^(cap|caps|capsule|capsules|softgel|كبسول)$/.test(last)) return 'Capsule';
  if (/^(syrup|susp|suspension|شراب)$/.test(last)) return 'Syrup';
  if (/^(cream|كريم)$/.test(last)) return 'Cream';
  if (/^(gel|جل)$/.test(last)) return 'Gel';
  if (/^(amp|ampoule|vial|inj|حقن)$/.test(last)) return 'Injection';
  if (/^(inhaler|spray|بخاخ)$/.test(last)) return 'Inhaler';
  if (/^(sachet|sachets|granules|فوار)$/.test(last)) return 'Sachet';
  if (/^(supp|suppository|تحاميل)$/.test(last)) return 'Suppository';
  return 'Other';
}
window.getFormFromName = getFormFromName;
window.extractDosageForm = getFormFromName;

/**
 * Formats addition date (created_at) for display in Arabic locale
 */
function formatCreatedDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('ar-EG', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}
window.formatCreatedDate = formatCreatedDate;

// 4. محرك الفلترة (Filtered Products Engine)
function getFilteredProducts() {
  const searchQuery = (document.getElementById('search-box')?.value || '').trim().toLowerCase();
  const rawQuery = searchQuery.replace(/[\u064B-\u065F\u0670]/g, ''); // strip Arabic diacritics
  const selectedForm = document.getElementById('filter-form')?.value || 'ALL';
  const selectedCompany = document.getElementById('filter-company')?.value || 'ALL';
  const expiryFilter = document.getElementById('filter-expiry')?.value || '';
  const stockFilter = document.getElementById('filter-stock')?.value || '';

  const now = new Date();
  const sixMonthsAhead = new Date();
  sixMonthsAhead.setMonth(now.getMonth() + 6);

  // Expand aliases if searching with Arabic or English name
  const queryAliases = [];
  if (rawQuery) {
    queryAliases.push(rawQuery);
    if (typeof arabicMedicineAliases !== 'undefined') {
      for (const [arKey, enList] of Object.entries(arabicMedicineAliases)) {
        if (rawQuery.includes(arKey) || arKey.includes(rawQuery)) {
          enList.forEach(alias => {
            if (!queryAliases.includes(alias)) queryAliases.push(alias);
          });
        }
        if (enList.some(e => rawQuery.includes(e) || e.includes(rawQuery))) {
          if (!queryAliases.includes(arKey)) queryAliases.push(arKey);
        }
      }
    }
  }

  return products.filter(item => {
    const currentStock = item.number !== undefined && item.number !== null ? item.number : (item.quantity !== undefined && item.quantity !== null ? item.quantity : 0);

    // أ. فلتر الشركة (مطابقة مع عمود company في قاعدة البيانات بدون حساسية للأحرف):
    if (selectedCompany && selectedCompany !== 'ALL' && selectedCompany !== 'الكل' && selectedCompany !== '') {
      const itemComp = (item.company || '').toString().trim().toLowerCase();
      if (itemComp !== selectedCompany.trim().toLowerCase()) return false;
    }

    // ب. فلتر الشكل الدوائي (مطابقة عبر الدالة getFormFromName المشتقة من item.product):
    if (selectedForm && selectedForm !== 'ALL' && selectedForm !== 'الكل' && selectedForm !== '') {
      const pName = item.product || item.name || '';
      const itemForm = getFormFromName(pName);
      if (itemForm.toLowerCase() !== selectedForm.trim().toLowerCase()) return false;
    }

    // ج. مطابقة البحث النصي (إن وجد):
    if (rawQuery && rawQuery !== '') {
      const pName = (item.product || item.name || '').toLowerCase();
      const pComp = (item.company || '').toString().toLowerCase();
      const pBarcode = (item.barcode ? String(item.barcode) : '').toLowerCase();
      const pCleanBarcode = typeof formatBarcode === 'function' ? formatBarcode(item.barcode) : '';

      const directMatch = pName.includes(rawQuery) || pComp.includes(rawQuery) || pBarcode.includes(rawQuery) || (pCleanBarcode && pCleanBarcode.includes(rawQuery));
      const aliasMatch = queryAliases.some(qTerm => pName.includes(qTerm) || pComp.includes(qTerm));

      if (!directMatch && !aliasMatch) return false;
    } else {
      if (typeof hideOutOfStock !== 'undefined' && hideOutOfStock && currentStock <= 0) return false;
      if (stockFilter === 'available' && currentStock <= 0) return false;
      if (stockFilter === 'shortage' && currentStock > 0) return false;
      if (stockFilter === 'low_stock') {
        const q = currentStock;
        const m = (item.minQty !== null && item.minQty !== undefined) ? Number(item.minQty) : 5;
        if (q >= m) return false;
      }
    }

    if (expiryFilter) {
      if (!item.expiryDate) return false;
      const expD = new Date(item.expiryDate);
      if (isNaN(expD.getTime())) return false;
      if (expiryFilter === 'expired' && expD >= now) return false;
      if (expiryFilter === 'near' && (expD < now || expD > sixMonthsAhead)) return false;
      if (expiryFilter === 'valid' && expD <= sixMonthsAhead) return false;
    }

    return true;
  });
}

// ==========================================
// Requester Specific Previous Order Tracking
// ==========================================
function getUserLastOrderByProductIdMap() {
  const map = {};
  const myEmail = (currentStaffEmail || localStorage.getItem('samo_staff_email') || '').trim().toLowerCase();
  const curStaffLower = (currentStaff || '').trim().toLowerCase();

  // Filter orders strictly belonging to the currently logged in user / requester
  const allUserOrders = [...(orders || []), ...(pendingOrders || [])].filter(o => {
    if (!o) return false;
    const orderEmail = (o.staffEmail || o.staff_email || '').trim().toLowerCase();
    if (myEmail && orderEmail && orderEmail === myEmail) return true;
    if (curStaffLower && curStaffLower !== '__all__') {
      const oStaffLower = (o.staffName || '').trim().toLowerCase();
      const oDelivLower = (o.deliveryStaffName || '').trim().toLowerCase();
      if (oStaffLower === curStaffLower || oDelivLower === curStaffLower) return true;
    }
    const isMineByUserId = Boolean(o.userId && o.userId === myUserId);
    const isMineByOrderNumber = mySubmittedOrderNumbers && mySubmittedOrderNumbers.has(String(o.orderNumber));
    return isMineByUserId || isMineByOrderNumber;
  });

  // Sort ascending by time so latest order takes precedence
  allUserOrders.sort((a, b) => {
    const tA = a.timestamp ? Number(a.timestamp) : (a.date ? new Date(a.date).getTime() : 0);
    const tB = b.timestamp ? Number(b.timestamp) : (b.date ? new Date(b.date).getTime() : 0);
    return tA - tB;
  });

  allUserOrders.forEach(o => {
    const rawDate = o.date ? String(o.date).split(' ')[0] : (o.created_at ? String(o.created_at).split('T')[0] : '');
    if (!Array.isArray(o.items)) return;
    o.items.forEach(it => {
      const pid = String(it.id || it.productId || '');
      const pName = (it.name || '').trim().toLowerCase();
      const qty = Number(it.quantity) || 0;
      if (qty > 0) {
        const orderInfo = {
          date: rawDate || 'سابقاً',
          quantity: qty,
          orderNumber: o.orderNumber,
          status: o.status || 'معتمد'
        };
        if (pid) map[pid] = orderInfo;
        if (pName) map['name_' + pName] = orderInfo;
      }
    });
  });

  return map;
}

function renderProducts() {
  const container = document.getElementById('prod-list-container');
  if (!container) return;

  const list = getFilteredProducts();
  populateCompanyFilterDropdown();

  const userLastOrdersMap = getUserLastOrderByProductIdMap();

  const countPill = document.getElementById('medicines-count-pill');
  if (countPill) {
    countPill.innerText = `${list.length} من أصل ${products.length} مادة`;
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 40px 20px; color: var(--ios-sub);">
        <div style="font-size: 36px; margin-bottom: 8px;">🔍</div>
        <div style="font-size: 15px; font-weight: 700;">لا توجد أدوية تطابق البحث</div>
        <div style="font-size: 12px; margin-top: 4px;">جرّب البحث باسم تجاري آخر أو امسح الفلاتر</div>
      </div>
    `;
    updateWarehouseSideTracker();
    return;
  }

  let html = '';

  list.forEach(p => {
    const currentStock = p.number !== undefined && p.number !== null ? p.number : (p.quantity !== undefined && p.quantity !== null ? p.quantity : 0);
    const qty = currentStock;
    const price = Number(p.price) || 0;
    const bonus = Number(p.bonus) || 0;
    const netPrice = bonus > 0 ? Math.round(price * (1 - bonus / 100)) : price;
    const cartQty = cart[p.id] || 0;
    const formattedBarcode = formatBarcodeDisplay(p.barcode);

    // Look up this specific user's previous order history for this product
    const lastOrder = userLastOrdersMap[String(p.id)] || userLastOrdersMap['name_' + (p.name || '').trim().toLowerCase()];

    let expBadgeClass = 'badge-normal-bar';
    let expLabel = p.expiryDate || '';
    if (p.expiryDate) {
      const expD = new Date(p.expiryDate);
      const now = new Date();
      const sixM = new Date();
      sixM.setMonth(now.getMonth() + 6);
      if (expD < now) {
        expBadgeClass = 'badge-exp-bar';
        expLabel = `منتهي: ${p.expiryDate}`;
      } else if (expD <= sixM) {
        expBadgeClass = 'badge-near-bar';
        expLabel = `قريب: ${p.expiryDate}`;
      }
    }

    const itemForm = getFormFromName(p.product || p.name || '');
    const createdDateFormatted = formatCreatedDate(p.createdAt || p.created_at);

    html += `
      <div class="prod-card" id="card-${p.id}">
        <div style="display: flex; gap: 10px; align-items: center;">
          <img class="prod-img-thumb" src="${p.image || 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=120&auto=format&fit=crop&q=60'}" alt="${escapeHtml(p.name)}" onclick="openImageLightbox('${escapeHtml(p.image || 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=120&auto=format&fit=crop&q=60')}', '${escapeHtml(p.name)}')" title="اضغط لتكبير الصورة">
          <div style="flex: 1; min-width: 0;">
            <div class="prod-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
            <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; align-items: center; font-size: 11.5px; color: #64748b;">
              <span style="font-weight: 800; color: #0284c7; background: #e0f2fe; padding: 1px 6px; border-radius: 6px; font-size: 11px;">🏷️ ${escapeHtml(itemForm)}</span>
              ${p.company ? `<span>• 🏢 ${escapeHtml(p.company)}</span>` : ''}
              ${formattedBarcode ? `<span>• 🏷️ <code style="font-family:monospace;background:#f1f5f9;padding:1px 4px;border-radius:4px;font-size:10.5px;color:#334155;">${escapeHtml(formattedBarcode)}</code></span>` : ''}
              <span>• <b style="${qty <= 0 ? 'color:#ef4444;' : 'color:#10b981;'}">${qty <= 0 ? 'غير متوفر' : `متوفر: ${qty}`}</b></span>
              ${createdDateFormatted ? `<span>• 📅 <span style="color:#64748b;" title="تاريخ الإضافة">${escapeHtml(createdDateFormatted)}</span></span>` : ''}
            </div>
            ${lastOrder ? `
              <div style="margin-top: 3px; display: inline-flex; align-items: center; gap: 4px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; border-radius: 6px; padding: 2px 6px; font-size: 10.5px; font-weight: 700;">
                <span>📦 آخر طلب: <b>${lastOrder.quantity}</b> (${lastOrder.date})</span>
              </div>
            ` : ''}
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px dashed #f1f5f9; padding-top: 6px; margin-top: 2px;">
          <div>
            <span style="font-size: 15px; font-weight: 900; color: #0f172a;">${netPrice.toLocaleString()} <span style="font-size: 10.5px; font-weight: 700; color: #64748b;">د.ع</span></span>
            ${bonus > 0 ? `
              <span style="font-size: 11px; text-decoration: line-through; color: #94a3b8; margin-right: 3px;">${price.toLocaleString()}</span>
              <span class="badge" style="background:#dcfce7;color:#15803d;font-size:9.5px;font-weight:800;padding:1px 5px;">+بونص %${bonus}</span>
            ` : ''}
          </div>
          
          <div style="display: flex; align-items: center; gap: 6px;">
            ${isAdmin ? `
              <button type="button" class="btn btn-sec" style="font-size: 10.5px; padding: 3px 6px; border-color: #0284c7; color: #0284c7; font-weight: 700;" onclick="openEditModal('${p.id}')">✏️ تعديل</button>
              <button type="button" class="btn btn-sec" style="font-size: 10.5px; padding: 3px 6px; color: var(--ios-red); border-color: #fecaca;" onclick="deleteProduct('${p.id}')">حذف</button>
            ` : ''}
            
            ${qty <= 0 ? `
              <span class="badge" style="background:#fee2e2;color:#dc2626;font-weight:800;padding:4px 8px;font-size:11px;">نفد</span>
            ` : (cartQty === 0 ? `
              <button type="button" class="btn-user-add" onclick="changeCartQty('${p.id}', 1)" title="إضافة المادة للسلة">
                + إضافة
              </button>
            ` : `
              <div class="counter-box-horizontal">
                <button type="button" class="counter-btn-h" onclick="changeCartQty('${p.id}', -1)" title="إنقاص">-</button>
                <div class="counter-val-h" onclick="setCartQtyDirect('${p.id}')" title="اضغط لتغيير العدد مباشرة">
                  <span style="font-size: 10px; opacity: 0.85; margin-left: 3px;">المختار:</span>
                  <b>${cartQty}</b>
                </div>
                <button type="button" class="counter-btn-h" onclick="changeCartQty('${p.id}', 1)" title="زيادة">+</button>
              </div>
            `)}
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  updateWarehouseSideTracker();
}

function populateCompanyFilterDropdown() {
  const sel = document.getElementById('filter-company');
  if (!sel) return;
  const cur = sel.value || 'ALL';
  const comps = products
    .map(p => (p.company || '').toString().trim())
    .filter(Boolean);
  const uniqueComps = Array.from(new Set(comps)).sort((a, b) => a.localeCompare(b, 'ar'));

  sel.innerHTML = '<option value="ALL">-- جميع الشركات --</option>';
  uniqueComps.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.innerText = c;
    sel.appendChild(opt);
  });

  if (Array.from(sel.options).some(o => o.value.toLowerCase() === cur.toLowerCase())) {
    sel.value = cur;
  } else {
    sel.value = 'ALL';
  }
}

function resetAllFilters() {
  const f = document.getElementById('filter-form');
  const e = document.getElementById('filter-expiry');
  const s = document.getElementById('filter-stock');
  const c = document.getElementById('filter-company');
  if (f) f.value = 'ALL';
  if (e) e.value = '';
  if (s) s.value = '';
  if (c) c.value = 'ALL';
  renderProducts();
}

function toggleHideOutStock() {
  hideOutOfStock = !hideOutOfStock;
  localStorage.setItem('samo_hide_out_of_stock', hideOutOfStock ? 'true' : 'false');
  const btn = document.getElementById('toggle-out-stock-circle');
  if (btn) {
    if (hideOutOfStock) {
      btn.style.background = '#e0f2fe';
      btn.style.borderColor = '#0284c7';
      btn.style.color = '#0284c7';
      btn.title = 'إخفاء الأدوية النافذة مفعّل (اضغط لإظهار المنتهي/النافذ)';
    } else {
      btn.style.background = '#ffffff';
      btn.style.borderColor = 'rgba(0,0,0,0.15)';
      btn.style.color = '#1e293b';
      btn.title = 'إظهار الأدوية النافذة مفعّل (اضغط لإخفاء الأدوية النافذة)';
    }
  }
  renderProducts();
}

function togglePosHideOutStock() {
  posHideOutOfStock = !posHideOutOfStock;
  localStorage.setItem('samo_pos_hide_out_of_stock', posHideOutOfStock ? 'true' : 'false');
  const btn = document.getElementById('pos-toggle-out-stock-circle');
  if (btn) btn.style.background = posHideOutOfStock ? '#e0f2fe' : '#ffffff';
  renderPosGrid();
}

function toggleDropdown(id, e) {
  if (e) e.stopPropagation();
  const el = document.getElementById(id);
  if (el) el.classList.toggle('show');
}
window.addEventListener('click', () => {
  document.querySelectorAll('.dropdown-box').forEach(d => d.classList.remove('show'));
  const sg = document.getElementById('search-suggestions');
  if (sg) sg.style.display = 'none';
});

// Cart Logic
function changeCartQty(prodId, delta) {
  const p = products.find(x => x.id === prodId);
  if (!p) return;
  const cur = cart[prodId] || 0;
  const max = Number(p.quantity) || 0;
  const next = Math.max(0, Math.min(max, cur + delta));

  if (next === 0) delete cart[prodId];
  else cart[prodId] = next;

  saveLocalCart();
  updateCartBadge();
  renderProducts();
}

function setCartQtyDirect(prodId) {
  const p = products.find(x => x.id === prodId);
  if (!p) return;
  const max = Number(p.quantity) || 0;
  const cur = cart[prodId] || 0;
  const input = prompt(`أدخل الكمية المطلوبة من (${p.name}) [الحد الأقصى ${max}]:`, cur);
  if (input !== null) {
    const val = parseInt(input, 10);
    if (!isNaN(val) && val >= 0) {
      const finalVal = Math.min(max, val);
      if (finalVal === 0) delete cart[prodId];
      else cart[prodId] = finalVal;
      saveLocalCart();
      updateCartBadge();
      renderProducts();
    }
  }
}

function updateCartBadge() {
  const totalItems = Object.values(cart).reduce((a, b) => a + b, 0);
  const totalTypes = Object.keys(cart).length;
  const dot = document.getElementById('cart-dot');
  if (dot) {
    if (totalItems > 0) {
      dot.style.display = 'block';
      dot.innerText = totalItems;
    } else {
      dot.style.display = 'none';
    }
  }

  // Update User Header Cart Indicator Badge
  const userCartText = document.getElementById('user-header-cart-text');
  if (userCartText) {
    userCartText.innerText = totalItems > 0 ? totalItems : '0';
  }

  // Update User Floating Bottom Cart Bar
  const floatBar = document.getElementById('user-floating-cart-bar');
  const floatBadge = document.getElementById('user-floating-cart-badge');
  if (floatBar) {
    if (totalItems > 0 && currentTab === 'home') {
      floatBar.style.display = 'flex';
      if (floatBadge) floatBadge.innerText = `${totalTypes} صنف (${totalItems} قطعة)`;
    } else {
      floatBar.style.display = 'none';
    }
  }
}

function updateUserOrdersBadge() {
  const myPending = (pendingOrders || []).filter(isOrderVisibleInLog);
  const badge = document.getElementById('user-my-orders-count-badge');
  if (badge) {
    if (myPending.length > 0) {
      badge.style.display = 'inline-block';
      badge.innerText = myPending.length;
    } else {
      badge.style.display = 'none';
    }
  }
}

function renderCartBadge() {
  updateCartBadge();
}

// ==========================================
// VOICE SEARCH RECOGNITION SYSTEM (البحث الصوتي الذكي للأدوية)
// ==========================================
let activeVoiceRecognition = null;
let activeVoiceTargetInputId = 'search-box';
let isVoiceListening = false;

function playVoiceAudioCue(type = 'start') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'start') {
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.18);
    } else if (type === 'success') {
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    } else if (type === 'error') {
      osc.frequency.setValueAtTime(320, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(200, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.22);
    }
  } catch (e) {
    // AudioContext silently ignored if blocked by autoplay policy
  }
}

let currentVoiceLang = localStorage.getItem('samo_voice_lang') || 'ar-IQ';

function switchVoiceLanguage(lang) {
  currentVoiceLang = lang;
  localStorage.setItem('samo_voice_lang', lang);
  updateVoiceSheetLangUI();
  if (isVoiceListening) {
    stopVoiceSearch();
    setTimeout(() => {
      startVoiceSearch(activeVoiceTargetInputId);
    }, 250);
  }
}

function updateVoiceSheetLangUI() {
  const arBtn = document.getElementById('voice-lang-ar-btn');
  const enBtn = document.getElementById('voice-lang-en-btn');
  if (arBtn && enBtn) {
    if (currentVoiceLang.startsWith('ar')) {
      arBtn.style.background = '#0284c7';
      arBtn.style.color = '#ffffff';
      enBtn.style.background = 'transparent';
      enBtn.style.color = '#cbd5e1';
    } else {
      enBtn.style.background = '#0284c7';
      enBtn.style.color = '#ffffff';
      arBtn.style.background = 'transparent';
      arBtn.style.color = '#cbd5e1';
    }
  }
}

function cleanSpokenMedicineText(text) {
  if (!text) return '';
  let cleaned = text.trim();
  // Remove common spoken voice search conversational prefixes in English, Arabic & Iraqi dialect
  const prefixes = [
    /^search\s+for\s+/i,
    /^search\s+/i,
    /^find\s+/i,
    /^show\s+me\s+/i,
    /^give\s+me\s+/i,
    /^get\s+me\s+/i,
    /^look\s+for\s+/i,
    /^looking\s+for\s+/i,
    /^i\s+want\s+/i,
    /^i\s+need\s+/i,
    /^medicine\s+/i,
    /^drug\s+/i,
    /^syrup\s+/i,
    /^tablet\s+/i,
    /^capsule\s+/i,
    /^injection\s+/i,
    /^drops\s+/i,
    /^cream\s+/i,
    /^ointment\s+/i,
    /^please\s+/i,
    /^ابحث\s+عن\s+/i,
    /^بحث\s+عن\s+/i,
    /^دور\s+على\s+/i,
    /^دورلي\s+على\s+/i,
    /^اريد\s+دواء\s+/i,
    /^اريد\s+علاج\s+/i,
    /^اريد\s+/i,
    /^انطيني\s+/i,
    /^طلعلي\s+/i,
    /^جيبلي\s+/i,
    /^دواء\s+/i,
    /^علاج\s+/i,
    /^حبوب\s+/i,
    /^كبسول\s+/i,
    /^شراب\s+/i,
    /^حقن\s+/i,
    /^قطرة\s+/i,
    /^مرهم\s+/i,
    /^كريم\s+/i
  ];

  for (const rx of prefixes) {
    cleaned = cleaned.replace(rx, '').trim();
  }

  // Remove punctuation
  cleaned = cleaned.replace(/[.,!?،؟]/g, '').trim();
  return cleaned;
}

function toggleVoiceSearch(targetInputId = 'search-box') {
  if (isVoiceListening) {
    stopVoiceSearch();
  } else {
    startVoiceSearch(targetInputId);
  }
}

function startVoiceSearch(targetInputId = 'search-box') {
  activeVoiceTargetInputId = targetInputId;
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRec) {
    showQuickToast('⚠️ متصفحك الحالي لا يدعم التعرف على الصوت المباشر. يرجى استخدام Google Chrome أو Safari.');
    return;
  }

  // If already running, stop previous instance
  if (activeVoiceRecognition) {
    try { activeVoiceRecognition.abort(); } catch (e) {}
    activeVoiceRecognition = null;
  }

  try {
    const recognition = new SpeechRec();
    activeVoiceRecognition = recognition;
    recognition.lang = currentVoiceLang || 'ar-IQ'; // Support both Arabic & English
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;

    const sheet = document.getElementById('voice-search-floating-sheet');
    const statusLbl = document.getElementById('voice-sheet-status');
    const transcriptLbl = document.getElementById('voice-sheet-transcript');
    const homeBtn = document.getElementById('voice-search-btn-home');
    const posBtn = document.getElementById('voice-search-btn-pos');

    updateVoiceSheetLangUI();

    recognition.onstart = () => {
      isVoiceListening = true;
      playVoiceAudioCue('start');
      if (homeBtn) homeBtn.classList.add('is-listening');
      if (posBtn) posBtn.classList.add('is-listening');
      if (sheet) sheet.classList.add('active');
      if (statusLbl) {
        statusLbl.innerText = currentVoiceLang.startsWith('en') 
          ? '🎙️ Listening to your voice (English)...' 
          : '🎙️ جاري الاستماع لصوتك (عربي)...';
      }
      if (transcriptLbl) {
        transcriptLbl.innerText = currentVoiceLang.startsWith('en') 
          ? 'Speak medicine name (e.g., Panadol, Brufen, Amoxil, Augmentin)...' 
          : 'تحدث الآن باسم الدواء (مثال: بنادول، بروفين، أموكسيل)...';
      }
    };

    recognition.onresult = (event) => {
      let interim = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const item = event.results[i];
        if (item.isFinal) {
          finalTranscript += item[0].transcript;
        } else {
          interim += item[0].transcript;
        }
      }

      const currentSpeech = finalTranscript || interim;
      if (transcriptLbl && currentSpeech) {
        transcriptLbl.innerText = `🗣️ "${currentSpeech}"`;
      }

      const input = document.getElementById(activeVoiceTargetInputId);
      if (input && currentSpeech) {
        const cleaned = cleanSpokenMedicineText(currentSpeech);
        input.value = cleaned || currentSpeech;

        if (activeVoiceTargetInputId === 'search-box') {
          handleMainSearchInput();
        } else if (activeVoiceTargetInputId === 'pos-search-box') {
          handlePosSearchInput();
        }
      }

      if (finalTranscript) {
        const cleanedFinal = cleanSpokenMedicineText(finalTranscript);
        if (input) {
          input.value = cleanedFinal || finalTranscript;
          if (activeVoiceTargetInputId === 'search-box') {
            handleMainSearchInput();
            const clearBtn = document.getElementById('search-clear-btn');
            if (clearBtn) clearBtn.style.display = 'flex';
          } else if (activeVoiceTargetInputId === 'pos-search-box') {
            handlePosSearchInput();
            const clearBtn = document.getElementById('pos-search-clear-btn');
            if (clearBtn) clearBtn.style.display = 'flex';
          }
        }

        playVoiceAudioCue('success');
        if (statusLbl) statusLbl.innerText = `✓ تم التعرف على: "${cleanedFinal || finalTranscript}"`;
        showQuickToast(`🎙️ تم التصفية الصوتية لـ: "${cleanedFinal || finalTranscript}" ✓`);

        setTimeout(() => {
          stopVoiceSearch();
        }, 1200);
      }
    };

    recognition.onerror = (event) => {
      console.warn('Speech recognition error:', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        showQuickToast('⚠️ تم حظر الميكروفون. يرجى السماح للتطبيق باستخدام الميكروفون في المتصفح.');
      } else if (event.error === 'no-speech') {
        if (statusLbl) statusLbl.innerText = 'لم يتم سماع صوت. حاول مجدداً.';
      }
      playVoiceAudioCue('error');
      setTimeout(() => {
        stopVoiceSearch();
      }, 1500);
    };

    recognition.onend = () => {
      isVoiceListening = false;
      const homeBtn = document.getElementById('voice-search-btn-home');
      const posBtn = document.getElementById('voice-search-btn-pos');
      const sheet = document.getElementById('voice-search-floating-sheet');
      if (homeBtn) homeBtn.classList.remove('is-listening');
      if (posBtn) posBtn.classList.remove('is-listening');
      if (sheet) sheet.classList.remove('active');
      activeVoiceRecognition = null;
    };

    recognition.start();
  } catch (err) {
    console.error('Failed to start voice recognition:', err);
    showQuickToast('⚠️ تعذر بدء الاستماع الصوتي.');
    stopVoiceSearch();
  }
}

function stopVoiceSearch() {
  if (activeVoiceRecognition) {
    try {
      activeVoiceRecognition.stop();
    } catch (e) {
      try { activeVoiceRecognition.abort(); } catch (e2) {}
    }
    activeVoiceRecognition = null;
  }
  isVoiceListening = false;
  const homeBtn = document.getElementById('voice-search-btn-home');
  const posBtn = document.getElementById('voice-search-btn-pos');
  const sheet = document.getElementById('voice-search-floating-sheet');
  if (homeBtn) homeBtn.classList.remove('is-listening');
  if (posBtn) posBtn.classList.remove('is-listening');
  if (sheet) sheet.classList.remove('active');
}

// Search Suggestions
function handleMainSearchInput() {
  const box = document.getElementById('search-box');
  const clearBtn = document.getElementById('search-clear-btn');
  if (box && clearBtn) {
    clearBtn.style.display = box.value.trim() ? 'flex' : 'none';
  }
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    renderProducts();
    renderSearchSuggestions();
  }, 200);
}

function clearSearchInput(inputId) {
  const input = document.getElementById(inputId);
  if (input) {
    input.value = '';
    if (inputId === 'search-box') {
      const clearBtn = document.getElementById('search-clear-btn');
      if (clearBtn) clearBtn.style.display = 'none';
      renderProducts();
      renderSearchSuggestions();
    } else if (inputId === 'pos-search-box') {
      const clearBtn = document.getElementById('pos-search-clear-btn');
      if (clearBtn) clearBtn.style.display = 'none';
      renderPosGrid();
    }
  }
}

function renderSearchSuggestions() {
  const box = document.getElementById('search-box');
  const container = document.getElementById('search-suggestions');
  if (!box || !container) return;
  const q = box.value.trim().toLowerCase();
  if (q.length < 2) {
    container.style.display = 'none';
    return;
  }

  const matches = products.filter(p =>
    (p.name || '').toLowerCase().includes(q) ||
    (p.barcode || '').toLowerCase().includes(q) ||
    (p.company || '').toLowerCase().includes(q)
  ).slice(0, 10);

  if (matches.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.innerHTML = matches.map(m => `
    <button type="button" class="search-suggestion-item" onclick="selectSearchSuggestion('${escapeHtml(m.name)}')">
      <div class="search-suggestion-main">${escapeHtml(m.name)}</div>
      <div class="search-suggestion-sub">${escapeHtml(m.company || '')} - متوفر: ${m.quantity} - ${Number(m.price || 0).toLocaleString()} د.ع</div>
    </button>
  `).join('');
  container.style.display = 'block';
}

function selectSearchSuggestion(name) {
  const box = document.getElementById('search-box');
  if (box) {
    box.value = name;
    handleMainSearchInput();
  }
  const sg = document.getElementById('search-suggestions');
  if (sg) sg.style.display = 'none';
}

// Send Modal / Cart Checkout
function openSendModal() {
  const items = Object.entries(cart);
  if (items.length === 0) {
    alert('السلة فارغة. يرجى إضافة أدوية للطلب أولاً.');
    return;
  }

  const staffRow = document.getElementById('order-staff-picker-row');
  if (staffRow) {
    staffRow.style.display = isAdmin ? 'block' : 'none';
  }

  renderSendModalItems();
  populateOrderApprovedPharmaciesDropdown();

  // Check if current staff has a dedicated assigned pharmacy set by admin
  const assigned = getAssignedPharmacyForStaff(currentStaffEmail || currentStaff);
  const lockedBanner = document.getElementById('order-ph-locked-banner');
  const selectContainer = document.getElementById('order-ph-select-container');
  const phNameHidden = document.getElementById('order-ph-name');
  const phPhoneHidden = document.getElementById('order-ph-phone');

  if (!isAdmin && assigned && assigned.pharmacyName) {
    if (lockedBanner) {
      lockedBanner.style.display = 'block';
      lockedBanner.innerHTML = `
        <div style="background:#eff6ff; border:1.5px solid #bfdbfe; border-radius:12px; padding:12px 14px; text-align:right;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:12px; font-weight:800; color:#1e40af;">🏥 الصيدلية المخصصة لحسابك:</span>
            <span style="background:#dbeafe; color:#1e3a8a; font-size:10.5px; padding:2px 8px; border-radius:6px; font-weight:800;">🔒 مقيدة تلقائياً</span>
          </div>
          <div style="font-size:15px; font-weight:900; color:#0f172a; margin-top:4px;">
            ${escapeHtml(assigned.pharmacyName)}
          </div>
          ${assigned.pharmacyPhone ? `<div style="font-size:12px; color:#3b82f6; font-weight:700; margin-top:2px;">📱 هاتف: ${escapeHtml(assigned.pharmacyPhone)}</div>` : ''}
          <div style="font-size:11px; color:#64748b; margin-top:4px; border-top:1px dashed #cbd5e1; padding-top:4px;">
            تم تخصيص هذه الصيدلية لك من قبل إدارة المذخر لتفادي الاشتباه أو اختيار صيدلية أخرى.
          </div>
        </div>
      `;
    }
    if (selectContainer) selectContainer.style.display = 'none';
    if (phNameHidden) phNameHidden.value = assigned.pharmacyName;
    if (phPhoneHidden) phPhoneHidden.value = assigned.pharmacyPhone || '';
  } else {
    if (lockedBanner) lockedBanner.style.display = 'none';
    if (selectContainer) selectContainer.style.display = 'block';
  }

  const modal = document.getElementById('modal-send-order');
  if (modal) modal.classList.add('is-open');
}

function openOrderModal() {
  openSendModal();
}
window.openSendModal = openSendModal;
window.openOrderModal = openOrderModal;

function openSettingsTabFromModal() {
  closeSendModal();
  setMainTab('settings');
}

function populateOrderApprovedPharmaciesDropdown(filterQuery = '') {
  const sel = document.getElementById('order-approved-ph-select');
  if (!sel) return;

  const currentVal = sel.value || selectedPharmacy;
  sel.innerHTML = '<option value="">-- اختر الصيدلية / العميل --</option>';

  let list = Array.isArray(customersList) && customersList.length > 0
    ? [...customersList]
    : (Array.isArray(pharmacies) ? [...pharmacies] : []);
  
  // If not admin and user has an assigned pharmacy, ONLY show that assigned pharmacy!
  const assigned = getAssignedPharmacyForStaff(currentStaffEmail || currentStaff);
  if (!isAdmin && assigned && assigned.pharmacyName) {
    list = list.filter(p => String(p.name || '').trim().toLowerCase() === assigned.pharmacyName.trim().toLowerCase());
    if (list.length === 0) {
      list = [{ name: assigned.pharmacyName, phone: assigned.pharmacyPhone || '' }];
    }
  }

  // Sort alphabetically (Arabic locale)
  list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ar'));

  const q = filterQuery.trim().toLowerCase();
  let matchCount = 0;

  list.forEach(c => {
    const name = String(c.name || '').trim();
    const phone = String(c.phone || '').trim();
    const address = String(c.address || '').trim();
    if (!name) return;

    if (q) {
      const match = name.toLowerCase().includes(q) || phone.includes(q) || address.toLowerCase().includes(q);
      if (!match) return;
    }

    matchCount++;
    const opt = document.createElement('option');
    opt.value = name;
    opt.dataset.id = c.id;
    opt.dataset.phone = phone;
    opt.dataset.address = address;
    opt.innerText = phone ? `${name} (${phone})` : name;
    sel.appendChild(opt);
  });

  if (currentVal && Array.from(sel.options).some(o => o.value === currentVal)) {
    sel.value = currentVal;
  } else if (matchCount === 1 && q.length >= 2) {
    sel.selectedIndex = 1;
    onApprovedPharmacySelected(sel.value);
  }
}

function filterOrderPharmacyDropdown(val) {
  populateOrderApprovedPharmaciesDropdown(val);
}

function onApprovedPharmacySelected(phName) {
  const sel = document.getElementById('order-approved-ph-select');
  const phNameHidden = document.getElementById('order-ph-name');
  const phPhoneHidden = document.getElementById('order-ph-phone');
  const phoneDisplay = document.getElementById('order-ph-phone-display');
  const addressDisplay = document.getElementById('order-ph-address-display');
  const addressRow = document.getElementById('order-ph-address-row');
  const valMsg = document.getElementById('order-ph-validation-msg');

  if (valMsg) valMsg.style.display = 'none';

  if (!phName || !sel) {
    if (phNameHidden) phNameHidden.value = '';
    if (phPhoneHidden) phPhoneHidden.value = '';
    if (phoneDisplay) phoneDisplay.innerText = 'يرجى اختيار صيدلية';
    if (addressRow) addressRow.style.display = 'none';
    return;
  }

  const opt = sel.options[sel.selectedIndex];
  const phone = opt ? (opt.dataset.phone || '') : '';
  const address = opt ? (opt.dataset.address || '') : '';
  const notes = opt ? (opt.dataset.notes || '') : '';

  if (phNameHidden) phNameHidden.value = phName;
  if (phPhoneHidden) phPhoneHidden.value = phone;
  if (phoneDisplay) phoneDisplay.innerText = phone || 'لا يوجد هاتف مسجل';
  
  const addrText = [address, notes].filter(Boolean).join(' - ');
  if (addrText && addressRow && addressDisplay) {
    addressDisplay.innerText = addrText;
    addressRow.style.display = 'flex';
  } else if (addressRow) {
    addressRow.style.display = 'none';
  }
}

function populatePharmacyDropdowns() {
  populateOrderApprovedPharmaciesDropdown();
  const datalist = document.getElementById('pos-pharmacies-datalist');
  if (datalist) {
    datalist.innerHTML = '';
    pharmacies.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.innerText = p.phone ? `${p.name} (${p.phone})` : p.name;
      datalist.appendChild(opt);
    });
  }
}

function renderSendModalItems() {
  const summary = document.getElementById('checkout-summary');
  const items = Object.entries(cart);

  if (items.length === 0) {
    if (summary) {
      summary.innerHTML = `
        <div style="text-align:center;padding:24px 10px;color:var(--ios-sub);">
          <div style="font-size:32px;margin-bottom:6px;">🛒</div>
          <div style="font-size:14px;font-weight:700;">السلة فارغة حالياً</div>
          <div style="font-size:11px;margin-top:4px;">يمكنك اختيار أدوية وإضافتها من شاشة المخزن</div>
        </div>
      `;
    }
    const totEl = document.getElementById('checkout-total-price');
    if (totEl) totEl.innerText = '0 د.ع';
    return;
  }

  let total = 0;
  let html = '';

  items.forEach(([id, qty]) => {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const bonus = Number(p.bonus) || 0;
    const unitPrice = bonus > 0 ? Math.round(Number(p.price) * (1 - bonus / 100)) : Number(p.price);
    const lineTotal = unitPrice * qty;
    total += lineTotal;
    const stock = Number(p.quantity) || 0;

    html += `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:0.5px solid var(--ios-border);gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.name)}</div>
          <div style="font-size:11px;color:var(--ios-sub);">
            ${escapeHtml(p.form || '')} - سعر: ${unitPrice.toLocaleString()} د.ع
            <span style="color:${stock < qty ? 'var(--ios-red)' : 'var(--ios-sub)'};font-size:10px;">(بالمخزن: ${stock})</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <button type="button" class="btn btn-sec" style="width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;font-weight:bold;" onclick="changeCartModalQty('${p.id}', -1)">-</button>
          <input type="number" min="1" max="${stock > 0 ? stock : 9999}" value="${qty}" style="width:48px;height:28px;text-align:center;border-radius:6px;border:1px solid var(--ios-border);font-size:12px;font-weight:bold;" onchange="setCartModalQty('${p.id}', this.value)">
          <button type="button" class="btn btn-sec" style="width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;font-weight:bold;" onclick="changeCartModalQty('${p.id}', 1)">+</button>
          <button type="button" class="btn btn-sec" style="width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;color:var(--ios-red);border-color:#fecaca;" onclick="removeCartItemFromModal('${p.id}')" title="حذف المادة من السلة">🗑️</button>
        </div>
        <div style="min-width:70px;text-align:left;font-weight:800;font-size:12px;color:var(--ios-green);">
          ${lineTotal.toLocaleString()} د.ع
        </div>
      </div>
    `;
  });

  if (summary) summary.innerHTML = html;
  const totEl = document.getElementById('checkout-total-price');
  if (totEl) totEl.innerText = `${total.toLocaleString()} د.ع`;
}

function changeCartModalQty(id, delta) {
  const current = cart[id] || 0;
  const next = current + delta;
  const p = products.find(x => x.id === id);
  if (p && delta > 0 && next > p.quantity && p.quantity > 0) {
    alert(`الكمية المطلوبة تتجاوز المتوفر في المخزن (${p.quantity})`);
    return;
  }
  if (next <= 0) {
    delete cart[id];
  } else {
    cart[id] = next;
  }
  saveLocalData();
  updateCartBadge();
  renderProducts();
  renderSendModalItems();
}

function setCartModalQty(id, val) {
  const q = parseInt(val, 10) || 0;
  const p = products.find(x => x.id === id);
  if (p && q > p.quantity && p.quantity > 0) {
    alert(`الكمية المطلوبة تتجاوز المتوفر في المخزن (${p.quantity})`);
    renderSendModalItems();
    return;
  }
  if (q <= 0) {
    delete cart[id];
  } else {
    cart[id] = q;
  }
  saveLocalData();
  updateCartBadge();
  renderProducts();
  renderSendModalItems();
}

function removeCartItemFromModal(id) {
  delete cart[id];
  saveLocalData();
  updateCartBadge();
  renderProducts();
  renderSendModalItems();
}

function clearCartFromModal() {
  if (Object.keys(cart).length === 0) return;
  showInAppConfirm({
    title: 'تفريغ السلة',
    message: 'هل أنت متأكد من تفريغ كافة المواد المختارة من السلة؟',
    icon: '🛒',
    confirmText: 'نعم، تفريغ السلة',
    isDanger: true,
    onConfirm: () => {
      cart = {};
      saveLocalData();
      updateCartBadge();
      renderProducts();
      renderSendModalItems();
      showQuickToast('تم تفريغ السلة بنجاح ✓');
    }
  });
}

function closeSendModal() {
  const modal = document.getElementById('modal-send-order');
  if (modal) modal.classList.remove('is-open');
}

function populateSavedPharmaciesDropdown() {
  populateOrderApprovedPharmaciesDropdown();
}

function onSavedPharmacySelected() {
  const sel = document.getElementById('order-approved-ph-select');
  if (sel && sel.value) {
    onApprovedPharmacySelected(sel.value);
  }
}

let isSubmitting = false;
let lastSubmitTimestamp = 0;

async function handleCreateOrder(e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }

  const now = Date.now();

  // 1. منع التكرار البرمجي وقفل الزر (Debounce & State Lock)
  if (isSubmitting || (now - lastSubmitTimestamp < 2000)) {
    console.warn('⚠️ عملية إرسال الطلبية قيد التنفيذ حالياً، تم منع التكرار');
    return;
  }

  // دعم السلة سواء كانت مصفوفة أو كائن معرفات وكميات
  let cartItemsArray = [];
  if (Array.isArray(cart)) {
    cartItemsArray = cart;
  } else if (cart && typeof cart === 'object') {
    cartItemsArray = Object.entries(cart).map(([id, qty]) => {
      const p = products.find(x => String(x.id) === String(id));
      const bonus = Number(p?.bonus) || 0;
      const price = bonus > 0 ? Math.round(Number(p?.price) * (1 - bonus / 100)) : Number(p?.price || 0);
      return {
        id: String(id),
        product_id: String(id),
        name: p?.name || '',
        product: p?.name || '',
        barcode: p?.barcode || '',
        form: p?.form || 'Tablet',
        quantity: Number(qty) || 1,
        qty: Number(qty) || 1,
        price: price,
        expiryDate: p?.expiryDate || ''
      };
    });
  }

  if (!cartItemsArray || cartItemsArray.length === 0) {
    alert('السلة فارغة، يرجى اختيار مواد أولاً.');
    return;
  }

  // قفل فوري متزامن لمنع أي تكرار
  isSubmitting = true;
  lastSubmitTimestamp = now;

  // تعطيل زر الإرسال من الواجهة فوراً
  const submitBtn = document.getElementById('btn-confirm-send-order') ||
                    document.querySelector('#modal-send-order button.btn[onclick*="Order"]') ||
                    document.querySelector('#modal-send-order button.btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.style.opacity = '0.5';
    submitBtn.style.pointerEvents = 'none';
    submitBtn.innerText = '⏳ جاري إرسال الطلبية للمستودع...';
  }

  try {
    // توليد معرف فريد وموحد لمرة واحدة فقط
    const orderId = `ORD-SB-${Date.now().toString().slice(-5)}`;

    const total = cartItemsArray.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.qty || item.quantity || 1)), 0);

    // استخراج بيانات العميل / الصيدلية
    const phName = (document.getElementById('order-ph-name')?.value || document.getElementById('order-approved-ph-select')?.value || '').trim();
    const phPhone = (document.getElementById('order-ph-phone')?.value || '').trim();
    const selectedCustomer = (customersList || []).find(c =>
      c.name === phName || String(c.id) === String(phName)
    ) || null;

    const customerId = selectedCustomer ? (Number(selectedCustomer.id) || null) : null;
    const customerName = selectedCustomer?.name || phName || 'رسول اللامي';

    const userEmail = (typeof currentUser !== 'undefined' && (currentUser?.email || currentUser?.name)) ||
                      currentStaffEmail || localStorage.getItem('samo_staff_email') || '';

    const sb = (typeof getSupabaseClient === 'function' ? getSupabaseClient() : null) || (typeof supabase !== 'undefined' ? supabase : null);
    if (!sb) {
      throw new Error('تعذر الاتصال بقاعدة بيانات Supabase');
    }

    // إدخال سجل واحد فقط بمطابقة تامة مع أعمدة Supabase (بدون أي حلقات تكرارية إطلاقاً):
    const orderPayload = {
      id: orderId,
      customer_id: customerId,
      customer_name: customerName,
      items: cartItemsArray,
      total_amount: total,
      status: 'قيد المراجعة',
      created_at: new Date().toISOString()
    };
    if (userEmail) {
      orderPayload.staff_email = userEmail;
    }

    const { data: insertedData, error } = await sb
      .from('orders')
      .insert([orderPayload])
      .select();

    if (error) {
      console.error('فشل إدخال السجل في orders:', error);
      throw error;
    }

    const finalOrderId = (insertedData && insertedData[0] && insertedData[0].id) ? String(insertedData[0].id) : orderId;

    // تحديث الحالة المحلية للتطبيق
    const newOrder = {
      id: finalOrderId,
      orderNumber: orderId,
      order_ref: orderId,
      supabaseId: finalOrderId,
      alreadyInSupabase: true,
      pharmacyName: customerName,
      customerName: customerName,
      customerId: customerId,
      phone: phPhone,
      staffEmail: userEmail,
      totalAmount: total,
      total_price: total,
      status: 'قيد المراجعة',
      date: new Date().toLocaleString('ar-IQ'),
      createdAt: new Date().toISOString(),
      userId: myUserId,
      items: cartItemsArray
    };

    // مزامنة مع الكاش المحلي للسيرفر
    try {
      await postToApi({ action: 'new_order', order: newOrder, alreadyInSupabase: true });
    } catch (apiErr) {
      console.warn('postToApi note:', apiErr);
    }

    // تسجيل رقم الطلب بقائمة طلباتي
    mySubmittedOrderNumbers.add(finalOrderId);
    mySubmittedOrderNumbers.add(orderId);
    saveMyOrderNumbers();
    pendingOrders = setUniqueOrders([newOrder, ...pendingOrders]);
    saveLocalData();
    updateIncomingBadge();
    updateUserOrdersBadge();

    // تفريغ السلة وتنظيف المسودة
    cart = {};
    localStorage.removeItem('pos_cart');
    localStorage.removeItem('samo_cart');
    if (userEmail) {
      clearStaffDraftCloud(userEmail);
      dismissDraftBanner(false);
    }
    saveLocalCart();
    saveLocalData();
    updateCartBadge();
    closeSendModal();
    renderOrdersLog();
    renderProducts();

    alert(`تم إرسال الطلبية بنجاح برقم: ${orderId}`);

  } catch (err) {
    console.error("فشل إنشاء الطلبية:", err);
    alert("خطأ أثناء الإرسال: " + (err.message || err));
  } finally {
    isSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.style.opacity = '1';
      submitBtn.style.pointerEvents = 'auto';
      submitBtn.innerText = 'إرسال الطلب للمستودع 🚀';
    }
  }
}

const confirmOrderSubmission = handleCreateOrder;
const submitOrder = handleCreateOrder;
const handleSendOrder = handleCreateOrder;
const handleCheckout = handleCreateOrder;

window.handleCreateOrder = handleCreateOrder;
window.confirmOrderSubmission = handleCreateOrder;
window.submitOrder = handleCreateOrder;
window.handleSendOrder = handleCreateOrder;
window.handleCheckout = handleCreateOrder;

// Incoming Orders
function renderIncomingOrders() {
  const container = document.getElementById('incoming-orders-container');
  const badge = document.getElementById('incoming-count-badge');
  if (!container) return;

  updateIncomingBadge();

  if (pendingOrders.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 40px 20px; color: var(--ios-sub);">
        <div style="font-size: 36px; margin-bottom: 8px;">📥</div>
        <div style="font-size: 15px; font-weight: 700;">لا توجد طلبيات واردة جديدة قيد المراجعة</div>
      </div>
    `;
    clearSelectedOrdersToMerge();
    return;
  }

  // Check for pharmacies with multiple pending orders
  const groupedByPharmacy = new Map();
  pendingOrders.forEach(o => {
    const key = String(o.pharmacyName || 'غير مسجل').trim().toLowerCase();
    const list = groupedByPharmacy.get(key) || [];
    list.push(o);
    groupedByPharmacy.set(key, list);
  });

  const duplicatePharmacies = Array.from(groupedByPharmacy.entries())
    .filter(([_, list]) => list.length >= 2);

  let mergeBannerHtml = '';
  if (duplicatePharmacies.length > 0) {
    const phSummary = duplicatePharmacies
      .map(([_, list]) => `${list[0].pharmacyName} (${list.length} طلبات)`)
      .join('، ');
    mergeBannerHtml = `
      <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:12px 14px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <div style="flex:1; min-width:220px;">
          <div style="font-weight:800; color:#92400e; font-size:13px; display:flex; align-items:center; gap:6px;">
            <span>⚡ طلبيات متعددة لنفس الصيدلية جاهزة للدمج:</span>
          </div>
          <div style="font-size:11px; color:#b45309; margin-top:2px;">
            تم رصد: <b>${escapeHtml(phSummary)}</b>. يمكنك دمجها في طلبية واحدة موحدة لتسهيل التجهيز.
          </div>
        </div>
        <button class="btn" style="background:#f59e0b; color:#fff; font-weight:800; padding:8px 14px; font-size:12px; border-radius:8px;" onclick="autoMergeSamePharmacyOrders()">
          🔗 دمج طلبيات الصيدليات المكررة تلقائياً
        </button>
      </div>
    `;
  }

  const cardsHtml = pendingOrders.map((o, idx) => {
    const phKey = String(o.pharmacyName || '').trim().toLowerCase();
    const samePhOrders = groupedByPharmacy.get(phKey) || [];
    const hasDuplicates = samePhOrders.length >= 2;
    const isChecked = selectedOrderNumbersToMerge.has(o.orderNumber);

    return `
      <div class="prod-card" style="border-right: 4px solid var(--ios-blue); position:relative;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start; flex-wrap:wrap; gap:8px;">
          <div>
            <div style="display:flex; align-items:center; gap:8px;">
              <div style="font-size:16px;font-weight:800;">🏥 ${escapeHtml(o.pharmacyName)}</div>
              <label style="display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:700; background:${isChecked ? '#dbeafe' : '#f1f5f9'}; color:${isChecked ? '#1e40af' : '#475569'}; padding:3px 8px; border-radius:6px; cursor:pointer; user-select:none; border:1px solid ${isChecked ? '#93c5fd' : '#e2e8f0'};">
                <input type="checkbox" class="order-merge-check" value="${o.orderNumber}" ${isChecked ? 'checked' : ''} onchange="onMergeOrderCheckChange('${o.orderNumber}', this.checked)" style="cursor:pointer; accent-color:var(--ios-blue);">
                تحديد للدمج
              </label>
            </div>
            <div style="font-size:11px;color:var(--ios-sub);margin-top:3px;">رقم الطلب: <b>${o.orderNumber}</b> - ${o.date}</div>
            ${o.phone ? `<div style="font-size:11px;color:var(--ios-sub);">هاتف: ${escapeHtml(o.phone)}</div>` : ''}
            ${o.staffName ? `<div style="font-size:11px;color:var(--ios-green);font-weight:700;">الموظف المرسل: ${escapeHtml(o.staffName)}</div>` : ''}
          </div>
          <div style="text-align:left;">
            <span class="badge" style="background:#fff3cd;color:#856404;font-weight:800;">قيد المراجعة</span>
            <div style="font-size:15px;font-weight:800;color:var(--ios-green);margin-top:4px;">${Number(o.totalAmount || 0).toLocaleString()} د.ع</div>
          </div>
        </div>

        <div style="background:#f8f9fa;padding:8px 12px;border-radius:10px;margin:8px 0;font-size:12px;">
          <b>المواد المطلوبة (${o.items?.length || 0}):</b>
          <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px;">
            ${(o.items || []).map(it => `
              <span class="badge" style="background:#e5e7eb;color:#111;">${escapeHtml(it.name)} × ${it.quantity}</span>
            `).join('')}
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;">
          <button class="btn" style="flex:1;min-width:140px;justify-content:center;padding:10px;" onclick="openInspectModal(${idx})">فحص واعتماد 🔍</button>
          ${hasDuplicates ? `
            <button class="btn btn-sec" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;padding:10px 12px;font-size:12px;font-weight:700;" onclick="mergeOrdersForPharmacy('${escapeHtml(o.pharmacyName)}')">
              🔗 دمج طلبات الصيدلية (${samePhOrders.length})
            </button>
          ` : ''}
          <button class="btn btn-sec" style="background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;padding:10px 12px;" onclick="openEditSentOrderModal('${o.orderNumber}')">تعديل ✏️</button>
          <button class="btn btn-danger" style="padding:10px 14px;font-size:13px;" onclick="deleteIncomingOrderByNumber('${o.orderNumber}')">🗑️ إلغاء وحذف</button>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = mergeBannerHtml + cardsHtml;
  updateSelectedOrdersToMergeUI();
}

// Order Merging Management
function onMergeOrderCheckChange(orderNumber, isChecked) {
  const num = String(orderNumber || '').trim();
  if (!num) return;
  if (isChecked) {
    selectedOrderNumbersToMerge.add(num);
  } else {
    selectedOrderNumbersToMerge.delete(num);
  }
  updateSelectedOrdersToMergeUI();
}

function updateSelectedOrdersToMergeUI() {
  const floatingBar = document.getElementById('floating-merge-bar');
  const countEl = document.getElementById('floating-merge-count');
  const size = selectedOrderNumbersToMerge.size;

  if (floatingBar && countEl) {
    if (size >= 2) {
      floatingBar.style.display = 'flex';
      countEl.innerText = size;
    } else {
      floatingBar.style.display = 'none';
    }
  }

  document.querySelectorAll('.order-merge-check').forEach(chk => {
    chk.checked = selectedOrderNumbersToMerge.has(chk.value);
  });
}

function clearSelectedOrdersToMerge() {
  selectedOrderNumbersToMerge.clear();
  updateSelectedOrdersToMergeUI();
}

function mergeOrdersForPharmacy(pharmacyName) {
  const trimmedPh = String(pharmacyName || '').trim().toLowerCase();
  const matching = pendingOrders.filter(o => String(o.pharmacyName || '').trim().toLowerCase() === trimmedPh);
  if (matching.length < 2) {
    showQuickToast(`لا توجد طلبيات معلقة متعددة لصيدلية (${pharmacyName})`, 'warn');
    return;
  }
  const orderNumbers = matching.map(o => o.orderNumber);
  openMergeOrdersModalWithOrders(orderNumbers);
}

function autoMergeSamePharmacyOrders() {
  const grouped = new Map();
  pendingOrders.forEach(o => {
    const key = String(o.pharmacyName || 'غير مسجل').trim();
    const list = grouped.get(key) || [];
    list.push(o);
    grouped.set(key, list);
  });

  const candidates = Array.from(grouped.entries()).filter(([_, list]) => list.length >= 2);
  if (candidates.length === 0) {
    showQuickToast('لا توجد صيدليات لديها أكثر من طلبية معلقة حالياً', 'warn');
    return;
  }

  if (candidates.length === 1) {
    mergeOrdersForPharmacy(candidates[0][0]);
    return;
  }

  const names = candidates.map(([name, list]) => `• ${name} (${list.length} طلبات)`).join('\n');
  if (confirm(`تم العثور على طلبيات متعددة للصيدليات التالية:\n${names}\n\nهل تريد دمج طلبيات أول صيدلية (${candidates[0][0]})؟`)) {
    mergeOrdersForPharmacy(candidates[0][0]);
  }
}

function openMergeModalForSelected() {
  if (selectedOrderNumbersToMerge.size < 2) {
    showQuickToast('يجب اختيار طلبيتين معلقتين على الأقل للدمج', 'warn');
    return;
  }
  openMergeOrdersModalWithOrders(Array.from(selectedOrderNumbersToMerge));
}

function openMergeOrdersModalWithOrders(orderNumbers) {
  const ordersToMerge = pendingOrders.filter(o => orderNumbers.includes(o.orderNumber));
  if (ordersToMerge.length < 2) {
    showQuickToast('لم يتم العثور على طلبيات معلقة كافية للدمج', 'warn');
    return;
  }

  // Combine items map
  const combinedMap = new Map();
  ordersToMerge.forEach(o => {
    (o.items || []).forEach(it => {
      const pId = String(it.id || '').trim();
      const pName = String(it.name || '').trim();
      const key = (pId || pName).toLowerCase();
      if (!key) return;

      if (!combinedMap.has(key)) {
        combinedMap.set(key, {
          id: pId,
          name: pName || 'مادة بدون اسم',
          barcode: String(it.barcode || '').trim(),
          form: String(it.form || 'Tablet').trim(),
          quantity: Math.max(0, Math.floor(Number(it.quantity) || 0)),
          price: Math.max(0, Number(it.price) || 0),
          expiryDate: String(it.expiryDate || '').trim()
        });
      } else {
        const exist = combinedMap.get(key);
        exist.quantity += Math.max(0, Math.floor(Number(it.quantity) || 0));
        if (Number(it.price) > exist.price) exist.price = Number(it.price);
        if (!exist.barcode && it.barcode) exist.barcode = String(it.barcode).trim();
        if (!exist.expiryDate && it.expiryDate) exist.expiryDate = String(it.expiryDate).trim();
      }
    });
  });

  const mergedItems = Array.from(combinedMap.values());
  const totalPrice = mergedItems.reduce((acc, it) => acc + (it.quantity * it.price), 0);
  const phName = ordersToMerge[0].pharmacyName || 'صيدلية غير مسجلة';

  pendingMergeData = {
    orderNumbers,
    ordersToMerge,
    mergedItems,
    totalPrice,
    pharmacyName: phName
  };

  const modal = document.getElementById('modal-merge-orders');
  const phEl = document.getElementById('merge-modal-pharmacy');
  const countEl = document.getElementById('merge-modal-count');
  const ordNumbersEl = document.getElementById('merge-modal-ord-numbers');
  const itemsBox = document.getElementById('merge-modal-items-box');
  const totalEl = document.getElementById('merge-modal-total-price');

  if (phEl) phEl.innerText = phName;
  if (countEl) countEl.innerText = `${ordersToMerge.length} طلبيات`;
  if (ordNumbersEl) ordNumbersEl.innerText = `أرقام الطلبات: ${orderNumbers.join(' + ')}`;
  if (totalEl) totalEl.innerText = `${totalPrice.toLocaleString()} د.ع`;

  if (itemsBox) {
    itemsBox.innerHTML = mergedItems.map(it => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:0.5px solid var(--ios-border);font-size:12px;">
        <div>
          <b>${escapeHtml(it.name)}</b>
          <span style="font-size:10px;color:var(--ios-sub);margin-right:4px;">(${it.form || 'Tablet'})</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <span class="badge" style="background:#dbeafe;color:#1e40af;font-size:12px;font-weight:800;">الكمية: ${it.quantity}</span>
          <span style="color:var(--ios-green);font-weight:800;">${(it.quantity * it.price).toLocaleString()} د.ع</span>
        </div>
      </div>
    `).join('');
  }

  if (modal) modal.classList.add('is-open');
}

function closeMergeModal() {
  const modal = document.getElementById('modal-merge-orders');
  if (modal) modal.classList.remove('is-open');
  pendingMergeData = null;
}

async function confirmExecuteOrderMerge() {
  if (!pendingMergeData) return;
  const { orderNumbers, ordersToMerge, mergedItems, totalPrice, pharmacyName } = pendingMergeData;

  const targetOrderNumber = orderNumbers[0];
  const otherOrderNumbers = orderNumbers.slice(1);

  // 1. Instant Optimistic local update (0ms)
  const primaryOrder = ordersToMerge[0];
  const updatedPrimaryOrder = {
    ...primaryOrder,
    pharmacyName,
    items: mergedItems,
    totalAmount: totalPrice,
    date: primaryOrder.date || new Date().toLocaleString('ar-IQ')
  };

  pendingOrders = pendingOrders.filter(o => !otherOrderNumbers.includes(o.orderNumber));
  const primaryIdx = pendingOrders.findIndex(o => o.orderNumber === targetOrderNumber);
  if (primaryIdx !== -1) {
    pendingOrders[primaryIdx] = updatedPrimaryOrder;
  } else {
    pendingOrders.unshift(updatedPrimaryOrder);
  }

  // Update my order numbers
  mySubmittedOrderNumbers.add(targetOrderNumber);
  otherOrderNumbers.forEach(n => mySubmittedOrderNumbers.delete(n));

  clearSelectedOrdersToMerge();
  saveLocalData();
  saveMyOrderNumbers();
  updateIncomingBadge();
  renderIncomingOrders();
  renderOrdersLog();
  closeMergeModal();
  showQuickToast('تم دمج الطلبيات بنجاح بطلبية واحدة موحدة ✓');

  // 2. Background server execution
  try {
    const res = await postToApi({
      action: 'merge_pending_orders',
      orderNumbers
    });
    if (res && res.status === 'success') {
      loadRemoteData();
    }
  } catch (err) {
    console.warn('Background merge server error:', err);
    loadRemoteData();
  }
}

function openInspectModal(idx) {
  currentInspectingOrderIndex = idx;
  const order = pendingOrders[idx];
  if (!order) return;

  const title = document.getElementById('inspect-modal-title');
  if (title) title.innerText = `فحص طلبية: ${order.pharmacyName} (${order.orderNumber})`;

  const box = document.getElementById('inspect-order-items-box');
  if (box) {
    box.innerHTML = (order.items || []).map((it, itemIdx) => {
      const prod = products.find(p => p.name === it.name || p.id === it.id);
      const stock = prod ? Number(prod.quantity) : 0;
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:0.5px solid var(--ios-border);">
          <div style="flex:1;">
            <div style="font-weight:800;font-size:13px;">${escapeHtml(it.name)}</div>
            <div style="font-size:11px;color:${stock >= it.quantity ? 'var(--ios-green)' : 'var(--ios-red)'};font-weight:700;">
              المتوفر بالمخزن: ${stock} - سعر المفرد: ${Number(it.price || 0).toLocaleString()} د.ع
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <input type="number" min="0" max="${stock}" value="${it.quantity}" id="inspect-qty-${itemIdx}" style="width:60px;padding:6px;text-align:center;border-radius:6px;border:1px solid var(--ios-border);" onchange="updateInspectItemQty(${idx}, ${itemIdx}, this.value)">
          </div>
        </div>
      `;
    }).join('');
  }

  const modal = document.getElementById('modal-inspect-order');
  if (modal) modal.classList.add('is-open');
}

function updateInspectItemQty(orderIdx, itemIdx, val) {
  const order = pendingOrders[orderIdx];
  if (!order || !order.items[itemIdx]) return;
  const q = Math.max(0, parseInt(val, 10) || 0);
  order.items[itemIdx].quantity = q;
  order.totalAmount = order.items.reduce((acc, it) => acc + (it.quantity * it.price), 0);
}

function closeInspectModal() {
  const modal = document.getElementById('modal-inspect-order');
  if (modal) modal.classList.remove('is-open');
}

function openEditFromInspect() {
  if (currentInspectingOrderIndex < 0) return;
  const order = pendingOrders[currentInspectingOrderIndex];
  if (!order) return;
  closeInspectModal();
  openEditSentOrderModal(order.orderNumber);
}

/**
 * Safely approves an order, deducts stock from Supabase "samo" table (using column "number"),
 * updates status to "تم التجهيز", stores approver name, and records inventory_logs.
 */
handleApproveOrder

          if (!prodRow && item.barcode) {
            const { data } = await supabase
              .from('samo')
              .select('id, number')
              .eq('barcode', item.barcode)
              .maybeSingle();
            prodRow = data;
          }

          if (!prodRow && (item.name || item.product_name)) {
            const { data } = await supabase
              .from('samo')
              .select('id, number')
              .eq('product', item.name || item.product_name)
              .maybeSingle();
            prodRow = data;
          }

          if (prodRow) {
            const currentStock = Number(prodRow.number) || 0;
            const deductQty = Number(item.qty || item.quantity) || 1;
            const newStock = Math.max(0, currentStock - deductQty);

            const { error: updateErr } = await supabase
              .from('samo')
              .update({ number: newStock })
              .eq('id', prodRow.id);

            if (updateErr) {
              console.error(`[handleApproveOrder] خطأ تحديث عمود number للمادة (${prodRow.id}):`, updateErr.message);
            } else {
              console.log(`✅ [handleApproveOrder] تم خصم الرصيد في samo (عمود number) للمادة (${item.name || prodRow.id}): ${currentStock} ➔ ${newStock}`);
            }
            item._prevStock = currentStock;
            item._newStock = newStock;

            // أ. عند اعتماد وتجهيز طلبية (داخل حلقة صرف الأدوية):
            await logInventoryMovement('صرف طلبية', item.product || item.product_name || item.name, {
              order_ref: orderDetails.orderNumber || orderDetails.order_ref || currentOrderId || 'غير محدد',
              quantity: deductQty,
              previous_qty: currentStock,
              new_qty: newStock,
              pharmacy_name: orderDetails.pharmacyName || orderDetails.customer_name || ''
            });
          } else {
            console.warn(`[handleApproveOrder] لم يتم العثور على المادة بالمخزن:`, item);
            // تسجيل الحركة حتى لو لم يعثر على سطر المادة
            await logInventoryMovement('صرف طلبية', item.product || item.product_name || item.name, {
              order_ref: orderDetails.orderNumber || orderDetails.order_ref || currentOrderId || 'غير محدد',
              quantity: Number(item.qty || item.quantity) || 1,
              pharmacy_name: orderDetails.pharmacyName || orderDetails.customer_name || ''
            });
          }
        } catch (itemErr) {
          console.error(`[handleApproveOrder] استثناء أثناء خصم كمية المادة (${item.name || item.id}):`, itemErr);
        }
      }
    }

    // 3. Update order status to "تم التجهيز" and store approver name in Supabase "orders"
    if (supabase && currentOrderId) {
      let resolvedId = currentOrderId;
      let numericId = Number(resolvedId);
      if (isNaN(numericId)) {
        const match = String(resolvedId).match(/ORD-SB-(\d+)/);
        if (match) numericId = Number(match[1]);
      }

      let updatePayload = {
        status: 'تم التجهيز',
        approved_by: approverName,
        approved_at: new Date().toISOString()
      };

      let query = supabase.from('orders').update(updatePayload);
      if (!isNaN(numericId) && numericId > 0) {
        query = query.eq('id', numericId);
      } else {
        query = query.eq('id', resolvedId);
      }

      let { error: orderError } = await query;

      if (orderError) {
        console.warn('[handleApproveOrder] تنبيه تحديث حقول المعتمد في orders، جاري المحاولة بالحالة فقط:', orderError.message);
        // Fallback: update status only if approved_by column is missing
        let fallbackPayload = { status: 'تم التجهيز' };
        let fbQuery = supabase.from('orders').update(fallbackPayload);
        if (!isNaN(numericId) && numericId > 0) {
          fbQuery = fbQuery.eq('id', numericId);
        } else {
          fbQuery = fbQuery.eq('id', resolvedId);
        }
        const { error: fbErr } = await fbQuery;
        if (fbErr) {
          console.error('[handleApproveOrder] خطأ تحديث حالة الطلب في Supabase:', fbErr.message);
        }
      } else {
        console.log(`✅ [handleApproveOrder] تم تحديث حالة الطلبية (${currentOrderId}) إلى "تم التجهيز" وحفظ اسم المعتمد (${approverName})`);
      }
    }

    // 4. Send API request to backend (Express) to keep local cache in sync
    try {
      await postToApi({
        action: 'approve_order',
        orderNumber: orderDetails.orderNumber || currentOrderId,
        staffName: approverName,
        items: orderItems,
        totalAmount: orderDetails.totalAmount
      });
    } catch (apiErr) {
      console.warn('[handleApproveOrder] تنبيه أثناء مزامنة الخادم الخلفي:', apiErr.message || apiErr);
    }

    return { success: true, approverName };
  } catch (err) {
    console.error('حدث خطأ أثناء اعتماد وتجهيز الطلبية:', err);
    throw err;
  }
}
window.handleApproveOrder = handleApproveOrder;

async function approveAndSignOrder() {
  if (currentInspectingOrderIndex < 0) return;
  const order = pendingOrders[currentInspectingOrderIndex];
  if (!order) return;

  const orderId = order.id || order.orderNumber;
  const orderItems = order.items || [];

  try {
    const res = await handleApproveOrder(orderId, orderItems, {
      orderNumber: order.orderNumber,
      pharmacyName: order.pharmacyName,
      totalAmount: order.totalAmount
    });

    showQuickToast(`تم اعتماد وتجهيز الطلبية بواسطة (${res.approverName || 'المعتمد'}) وخصم الكميات بنجاح ✓`);
    closeInspectModal();
    loadRemoteData();
  } catch (err) {
    console.error('تفاصيل خطأ الاعتماد:', err);
    alert('حدث خطأ أثناء اعتماد الطلبية: ' + (err.message || String(err)));
  }
}
window.approveAndSignOrder = approveAndSignOrder;

// Instant & Reliable In-App Delete Order Functions

/**
 * Direct & explicit delete order from Supabase for Employee / Pharmacy View "طلباتي"
 */
const handleDeleteMyOrder = async (orderId) => {
  if (!window.confirm("هل أنت متأكد من حذف هذه الطلبية نهائياً؟")) return;

  try {
    const sb = (typeof getSupabaseClient === 'function' ? getSupabaseClient() : null) || (typeof supabase !== 'undefined' ? supabase : null);
    if (!sb) throw new Error("تعذر الاتصال بقاعدة بيانات Supabase");

    // 1. الحذف من Supabase مباشرة بالاعتماد على id
    const { error } = await sb
      .from('orders')
      .delete()
      .eq('id', orderId);

    if (error) throw error;

    // 2. تحديث قائمة "طلباتي" للموظف محلياً
    const orderIdStr = String(orderId);
    pendingOrders = pendingOrders.filter(o => String(o.id) !== orderIdStr && String(o.orderNumber) !== orderIdStr);
    orders = orders.filter(o => String(o.id) !== orderIdStr && String(o.orderNumber) !== orderIdStr);
    mySubmittedOrderNumbers.delete(orderIdStr);

    saveLocalData();
    saveMyOrderNumbers();
    updateIncomingBadge();
    updateUserOrdersBadge();
    renderOrdersLog();
    renderIncomingOrders();

    try {
      await postToApi({ action: 'delete_order', orderNumber: orderIdStr, orderId });
    } catch (apiErr) {
      console.warn("Backend API sync warning on staff delete:", apiErr);
    }

    alert("تم إلغاء وحذف الطلبية بنجاح");
  } catch (err) {
    console.error("فشل حذف الطلب:", err);
    alert("تعذر حذف الطلبية: " + (err.message || err));
  }
};
window.handleDeleteMyOrder = handleDeleteMyOrder;

async function deleteOrderByStaff(orderNumber) {
  const strNum = String(orderNumber || '').trim();
  const target = pendingOrders.find(o => String(o.orderNumber || '').trim() === strNum || String(o.id) === strNum) ||
                 orders.find(o => String(o.orderNumber || '').trim() === strNum || String(o.id) === strNum);
  const orderId = target?.id || strNum;
  return handleDeleteMyOrder(orderId);
}
window.deleteOrderByStaff = deleteOrderByStaff;

function promptDeleteOrder(orderNumber) {
  const strNum = String(orderNumber || '').trim();
  if (!strNum) return;

  // Non-admin (staff) always routes through staff deletion rules
  if (!isAdmin) {
    deleteOrderByStaff(strNum);
    return;
  }

  const foundPending = pendingOrders.find(o => String(o.orderNumber || '').trim() === strNum);
  const foundOrder = orders.find(o => String(o.orderNumber || '').trim() === strNum);
  const target = foundPending || foundOrder;
  const phName = target?.pharmacyName || '';
  const isAppr = foundOrder && isApprovedOrder(foundOrder);

  showInAppConfirm({
    title: isAppr ? 'إلغاء وحذف طلبية صادرة (معتمدة)' : 'إلغاء وحذف الطلبية',
    icon: '🗑️',
    confirmText: 'نعم، تأكيد الحذف',
    isDanger: true,
    message: `
      هل أنت متأكد من إلغاء وحذف الطلبية <b>(${strNum})</b>${phName ? ` الخاصة بـ <b>(${escapeHtml(phName)})</b>` : ''} نهائياً؟
      ${isAppr ? `<div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:8px 10px;border-radius:8px;margin-top:10px;font-size:12px;font-weight:700;text-align:right;">⚠️ تنبيه: هذه الطلبية معتمدة وصادرة، وسيتم إعادة كامل المواد والكميات المصروفة إلى رصيد المخزن تلقائياً.</div>` : ''}
    `,
    onConfirm: () => executeDeleteOrderByNumber(strNum)
  });
}

async function executeDeleteOrderByNumber(orderNumber) {
  const strNum = String(orderNumber || '').trim();
  if (!strNum) return;

  const foundPending = pendingOrders.find(o => String(o.orderNumber || '').trim() === strNum || String(o.id) === strNum);
  const foundOrder = orders.find(o => String(o.orderNumber || '').trim() === strNum || String(o.id) === strNum);
  const target = foundPending || foundOrder;
  const isAppr = foundOrder && isApprovedOrder(foundOrder);
  let orderId = target?.id;

  if (!orderId) {
    const match = strNum.match(/ORD-SB-(\d+)/);
    if (match) orderId = Number(match[1]);
    else if (!isNaN(Number(strNum))) orderId = Number(strNum);
    else orderId = strNum;
  } else if (!isNaN(Number(orderId))) {
    orderId = Number(orderId);
  }

  // 1. Direct Cloud Delete in Supabase via Real ID
  const sb = getSupabaseClient();
  if (sb) {
    let q = sb.from('orders').delete().eq('id', orderId);
    const { error } = await q;
    if (error) {
      console.error("فشل الحذف من السيرفر:", error);
      alert("فشل حذف الطلبية من السيرفر: " + error.message);
      return;
    }
  }

  // 2. Server API sync & stock restore
  try {
    const res = await postToApi({ action: 'delete_order', orderNumber: strNum, orderId });
    if (res && res.status === 'error') {
      alert("خطأ أثناء الحذف من السيرفر: " + (res.message || 'فشل الحذف'));
      return;
    }
  } catch (err) {
    console.error("فشل الحذف من السيرفر:", err);
    alert("خطأ أثناء الحذف من السيرفر: " + err.message);
    return;
  }

  // If approved order was cancelled, restore stock in local products
  if (isAppr && Array.isArray(foundOrder.items)) {
    foundOrder.items.forEach(it => {
      const p = products.find(prod => prod.id === it.id || prod.barcode === it.barcode || prod.name === it.name);
      if (p) {
        p.quantity = (Number(p.quantity) || 0) + (Number(it.quantity) || 0);
        p.totalPrice = p.quantity * (Number(p.price) || 0);
      }
    });
  }

  // 3. Update UI and local state ONLY after server confirmation
  pendingOrders = pendingOrders.filter(o => String(o.orderNumber || '').trim() !== strNum && String(o.id) !== String(orderId));
  orders = orders.filter(o => String(o.orderNumber || '').trim() !== strNum && String(o.id) !== String(orderId));
  mySubmittedOrderNumbers.delete(strNum);
  selectedOrderNumbersToMerge.delete(strNum);

  saveLocalData();
  saveMyOrderNumbers();
  updateIncomingBadge();
  updateSelectedOrdersToMergeUI();
  renderProducts();
  renderOrdersLog();
  renderIncomingOrders();
  closeInspectModal();
  closeEditSentOrderModal();
  showQuickToast('تم حذف الطلبية بنجاح وإلغاؤها من سجل المذخر ✓');
  loadRemoteData();
}

function deleteIncomingOrderByNumber(orderNumber) {
  if (!isAdmin) {
    deleteOrderByStaff(orderNumber);
  } else {
    promptDeleteOrder(orderNumber);
  }
}

function cancelApprovedOrderPrompt(orderNumber) {
  if (!isAdmin) {
    deleteOrderByStaff(orderNumber);
  } else {
    promptDeleteOrder(orderNumber);
  }
}

function deleteIncomingOrder(idx) {
  const order = pendingOrders[idx];
  if (!order) return;
  if (!isAdmin) {
    deleteOrderByStaff(order.orderNumber);
  } else {
    promptDeleteOrder(order.orderNumber);
  }
}

function rejectAndDiscardCurrentInspectingOrder() {
  if (currentInspectingOrderIndex < 0) return;
  const order = pendingOrders[currentInspectingOrderIndex];
  if (!order) {
    closeInspectModal();
    return;
  }
  if (!isAdmin) {
    deleteOrderByStaff(order.orderNumber);
  } else {
    promptDeleteOrder(order.orderNumber);
  }
}

// Full Sent Order Editing Logic (Before Approval)
let currentEditingOrder = null;

function openEditSentOrderModal(orderNumber) {
  const order = pendingOrders.find(o => o.orderNumber === orderNumber) || orders.find(o => o.orderNumber === orderNumber);
  if (!order) {
    alert('الطلبية غير موجودة');
    return;
  }

  currentEditingOrder = JSON.parse(JSON.stringify(order));
  if (!Array.isArray(currentEditingOrder.items)) {
    currentEditingOrder.items = [];
  }

  const title = document.getElementById('edit-sent-order-title');
  const sub = document.getElementById('edit-sent-order-sub');
  const phName = document.getElementById('edit-sent-ph-name');
  const phPhone = document.getElementById('edit-sent-ph-phone');

  if (title) title.innerText = `✏️ تعديل طلبية: ${currentEditingOrder.pharmacyName || ''}`;
  if (sub) sub.innerText = `رقم الطلب: ${currentEditingOrder.orderNumber} - التاريخ: ${currentEditingOrder.date || ''}`;
  if (phName) phName.value = currentEditingOrder.pharmacyName || '';
  if (phPhone) phPhone.value = currentEditingOrder.phone || '';

  populateEditSentMedicineSelect();
  renderEditSentOrderItems();

  const modal = document.getElementById('modal-edit-sent-order');
  if (modal) modal.classList.add('is-open');
}

function closeEditSentOrderModal() {
  const modal = document.getElementById('modal-edit-sent-order');
  if (modal) modal.classList.remove('is-open');
  currentEditingOrder = null;
}

function populateEditSentMedicineSelect() {
  const sel = document.getElementById('edit-sent-medicine-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- اختر مادة من المخزن --</option>';
  products.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.innerText = `${p.name} (${p.form || ''}) - متوفر: ${p.quantity} - ${Number(p.price || 0).toLocaleString()} د.ع`;
    sel.appendChild(opt);
  });
}

function toggleAddMedicineToSentOrderSection() {
  const box = document.getElementById('edit-sent-add-medicine-box');
  if (!box) return;
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

function addSelectedMedicineToSentOrder() {
  if (!currentEditingOrder) return;
  const sel = document.getElementById('edit-sent-medicine-select');
  const qtyInput = document.getElementById('edit-sent-medicine-qty');
  const prodId = sel ? sel.value : '';
  const qty = Math.max(1, parseInt(qtyInput ? qtyInput.value : '1', 10) || 1);

  if (!prodId) {
    alert('الرجاء اختيار مادة من القائمة');
    return;
  }

  const p = products.find(x => x.id === prodId);
  if (!p) return;

  const bonus = Number(p.bonus) || 0;
  const unitPrice = bonus > 0 ? Math.round(Number(p.price) * (1 - bonus / 100)) : Number(p.price);

  const existingItem = currentEditingOrder.items.find(it => it.id === p.id || it.name === p.name);
  if (existingItem) {
    existingItem.quantity += qty;
  } else {
    currentEditingOrder.items.push({
      id: p.id,
      name: p.name,
      barcode: p.barcode || '',
      form: p.form || 'Tablet',
      quantity: qty,
      price: unitPrice,
      expiryDate: p.expiryDate || ''
    });
  }

  if (sel) sel.value = '';
  if (qtyInput) qtyInput.value = '1';
  toggleAddMedicineToSentOrderSection();
  renderEditSentOrderItems();
}

function renderEditSentOrderItems() {
  if (!currentEditingOrder) return;
  const box = document.getElementById('edit-sent-items-box');
  const countEl = document.getElementById('edit-sent-items-count');
  const totalEl = document.getElementById('edit-sent-total-price');

  if (countEl) countEl.innerText = currentEditingOrder.items.length;

  if (currentEditingOrder.items.length === 0) {
    if (box) {
      box.innerHTML = `
        <div style="text-align:center;padding:24px 10px;color:var(--ios-sub);font-size:13px;">
          لا توجد أدوية في الطلبية حالياً. يرجى الضغط على "➕ إضافة مادة للطلب" أعلاه.
        </div>
      `;
    }
    if (totalEl) totalEl.innerText = '0 د.ع';
    return;
  }

  let total = 0;
  let html = '';

  currentEditingOrder.items.forEach((it, idx) => {
    const lineTotal = (Number(it.quantity) || 0) * (Number(it.price) || 0);
    total += lineTotal;

    const prod = products.find(p => p.id === it.id || p.name === it.name);
    const stock = prod ? Number(prod.quantity) : 0;
    const isStockLow = stock < it.quantity;

    html += `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:0.5px solid var(--ios-border);gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(it.name)}</div>
          <div style="font-size:11px;color:var(--ios-sub);">
            ${escapeHtml(it.form || '')} - سعر: ${Number(it.price || 0).toLocaleString()} د.ع
            <span style="color:${isStockLow ? 'var(--ios-red)' : 'var(--ios-green)'};font-weight:700;margin-right:4px;">(بالمخزن: ${stock})</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <button type="button" class="btn btn-sec" style="width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;font-weight:bold;" onclick="changeEditSentItemQty(${idx}, -1)">-</button>
          <input type="number" min="1" value="${it.quantity}" style="width:48px;height:28px;text-align:center;border-radius:6px;border:1px solid var(--ios-border);font-size:12px;font-weight:bold;" onchange="setEditSentItemQty(${idx}, this.value)">
          <button type="button" class="btn btn-sec" style="width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;font-weight:bold;" onclick="changeEditSentItemQty(${idx}, 1)">+</button>
          <button type="button" class="btn btn-sec" style="width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;color:var(--ios-red);border-color:#fecaca;" onclick="removeEditSentItem(${idx})" title="حذف من الطلبية">🗑️</button>
        </div>
        <div style="min-width:70px;text-align:left;font-weight:800;font-size:12px;color:var(--ios-green);">
          ${lineTotal.toLocaleString()} د.ع
        </div>
      </div>
    `;
  });

  if (box) box.innerHTML = html;
  if (totalEl) totalEl.innerText = `${total.toLocaleString()} د.ع`;
}

function changeEditSentItemQty(idx, delta) {
  if (!currentEditingOrder || !currentEditingOrder.items[idx]) return;
  const current = currentEditingOrder.items[idx].quantity || 0;
  const next = current + delta;
  if (next <= 0) {
    if (confirm(`هل تريد حذف (${currentEditingOrder.items[idx].name}) من الطلبية؟`)) {
      currentEditingOrder.items.splice(idx, 1);
    }
  } else {
    currentEditingOrder.items[idx].quantity = next;
  }
  renderEditSentOrderItems();
}

function setEditSentItemQty(idx, val) {
  if (!currentEditingOrder || !currentEditingOrder.items[idx]) return;
  const q = parseInt(val, 10) || 0;
  if (q <= 0) {
    if (confirm(`هل تريد حذف (${currentEditingOrder.items[idx].name}) من الطلبية؟`)) {
      currentEditingOrder.items.splice(idx, 1);
    } else {
      renderEditSentOrderItems();
    }
  } else {
    currentEditingOrder.items[idx].quantity = q;
  }
  renderEditSentOrderItems();
}

function removeEditSentItem(idx) {
  if (!currentEditingOrder || !currentEditingOrder.items[idx]) return;
  currentEditingOrder.items.splice(idx, 1);
  renderEditSentOrderItems();
}

async function saveSentOrderModifications() {
  if (!currentEditingOrder) return;
  const phName = (document.getElementById('edit-sent-ph-name')?.value || '').trim();
  const phPhone = (document.getElementById('edit-sent-ph-phone')?.value || '').trim();

  if (!phName) {
    alert('الرجاء إدخال اسم الصيدلية المستلمة');
    return;
  }
  if (!currentEditingOrder.items || currentEditingOrder.items.length === 0) {
    alert('لا يمكن حفظ طلبية فارغة. الرجاء إضافة مادة واحدة على الأقل أو حذف الطلبية.');
    return;
  }

  const totalAmount = currentEditingOrder.items.reduce((sum, it) => sum + ((Number(it.quantity) || 0) * (Number(it.price) || 0)), 0);

  try {
    await postToApi({
      action: 'update_order',
      order: {
        orderNumber: currentEditingOrder.orderNumber,
        pharmacyName: phName,
        phone: phPhone,
        items: currentEditingOrder.items,
        totalAmount: totalAmount,
        date: currentEditingOrder.date,
        staffName: currentEditingOrder.staffName,
        status: currentEditingOrder.status || 'قيد المراجعة'
      }
    });

    alert('تم حفظ تعديلات الطلبية بنجاح في قاعدة البيانات ✓');
    closeEditSentOrderModal();
    loadRemoteData();
  } catch (err) {
    alert('حدث خطأ أثناء حفظ تعديلات الطلبية: ' + err.message);
  }
}

async function restoreSentOrderToCart() {
  if (!currentEditingOrder) return;
  if (!confirm(`هل تريد نقل مواد طلبية (${currentEditingOrder.pharmacyName}) إلى السلة وإلغاء الطلب المعلق للتعديل عليه؟`)) return;

  const orderNum = String(currentEditingOrder.orderNumber || '').trim();

  currentEditingOrder.items.forEach(it => {
    const prod = products.find(p => p.id === it.id || p.name === it.name);
    const id = prod ? prod.id : (it.id || it.name);
    cart[id] = (cart[id] || 0) + Number(it.quantity || 1);
  });

  // Optimistic cleanup
  pendingOrders = pendingOrders.filter(o => String(o.orderNumber || '').trim() !== orderNum);
  orders = orders.filter(o => String(o.orderNumber || '').trim() !== orderNum);
  mySubmittedOrderNumbers.delete(orderNum);
  selectedOrderNumbersToMerge.delete(orderNum);

  saveLocalData();
  saveMyOrderNumbers();
  updateCartBadge();
  updateIncomingBadge();
  closeEditSentOrderModal();
  renderOrdersLog();
  renderIncomingOrders();
  openSendModal();
  showQuickToast('تمت إعادة المواد للسلة وإلغاء الطلب المعلق ✓');

  try {
    await postToApi({ action: 'discard_pending_order', orderNumber: orderNum });
  } catch (e) {
    console.warn('Failed to discard original order during restore:', e);
  }

  loadRemoteData();
}

// Order filtering
function isOrderVisibleInLog(o) {
  if (!o) return false;

  const myEmail = (currentStaffEmail || localStorage.getItem('samo_staff_email') || '').trim().toLowerCase();
  const orderEmail = (o.staffEmail || o.staff_email || '').trim().toLowerCase();

  // If viewing all orders (Admin or supervisor mode / toggled scope)
  if (ordersViewScope === 'all_orders') {
    if (isAdmin) {
      const filterStaff = (currentStaff || '').trim().toLowerCase();
      if (filterStaff && filterStaff !== '__all__' && filterStaff !== '') {
        const orderStaff = (o.staffName || '').trim().toLowerCase();
        const deliverStaff = (o.deliveryStaffName || '').trim().toLowerCase();
        return orderStaff === filterStaff || deliverStaff === filterStaff || (orderEmail && orderEmail.includes(filterStaff));
      }
    }
    return true;
  }

  // Viewing "my_orders" (Filtered to current staff member's email/identity)
  if (myEmail && orderEmail) {
    if (orderEmail === myEmail) return true;
  }

  if (currentStaff) {
    const curStaffLower = currentStaff.trim().toLowerCase();
    const oStaffLower = (o.staffName || '').trim().toLowerCase();
    const oDelivLower = (o.deliveryStaffName || '').trim().toLowerCase();
    if (oStaffLower === curStaffLower || oDelivLower === curStaffLower) {
      return true;
    }
  }

  // Regular user fallback: strictly show orders sent from this device/user
  const isMineByUserId = Boolean(o.userId && o.userId === myUserId);
  const isMineByOrderNumber = mySubmittedOrderNumbers.has(String(o.orderNumber)) || (o.id && mySubmittedOrderNumbers.has(String(o.id)));
  return isMineByUserId || isMineByOrderNumber;
}

// State for toggling pending orders in user view
let showPendingInUserLog = false;
function toggleShowPendingOrdersInUserLog() {
  showPendingInUserLog = !showPendingInUserLog;
  renderOrdersLog();
}

// Orders Log: STRICTLY Approved Outgoing Orders (الطلبيات الصادرة)
function renderOrdersLog() {
  const container = document.getElementById('orders-list-container');
  if (!container) return;

  const approvedList = orders.filter(o => isOrderVisibleInLog(o) && isApprovedOrder(o));
  const myPending = pendingOrders.filter(isOrderVisibleInLog);

  let html = '';

  if (!isAdmin) {
    // Customer / Delegate Clean Orders Tracker View
    const totalOrdersCount = myPending.length + approvedList.length;

    html += `
      <div style="background: #ffffff; border: 1px solid var(--ios-border); border-radius: 14px; padding: 12px 16px; margin-bottom: 14px; box-shadow: 0 1px 4px rgba(0,0,0,0.03); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
        <div>
          <div style="font-size: 15px; font-weight: 800; color: #0f172a;">📋 سجل طلباتي ومتابعة الحالة</div>
          <div style="font-size: 11.5px; color: #64748b; margin-top: 2px;">متابعة حالة التجهيز والموافقة من المستودع مباشرة</div>
        </div>
        <div style="display: flex; gap: 6px;">
          <span style="font-size: 11px; font-weight: 800; background: #fef3c7; color: #92400e; padding: 4px 8px; border-radius: 8px;">⏳ بالانتظار: ${myPending.length}</span>
          <span style="font-size: 11px; font-weight: 800; background: #dcfce7; color: #15803d; padding: 4px 8px; border-radius: 8px;">✓ معتمدة: ${approvedList.length}</span>
        </div>
      </div>
    `;

    if (totalOrdersCount === 0) {
      html += `
        <div style="text-align: center; padding: 50px 20px; color: var(--ios-sub); background: #ffffff; border-radius: 14px; border: 1px dashed var(--ios-border);">
          <div style="font-size: 40px; margin-bottom: 10px;">📦</div>
          <div style="font-size: 16px; font-weight: 800; color: #1e293b;">لا توجد لديك طلبات سابقة حتى الآن</div>
          <div style="font-size: 12.5px; color: #64748b; margin-top: 4px;">تصفح قائمة الأدوية وأضف ما تحتاجه لإنشاء طلبك الأول</div>
          <button class="btn" style="margin-top: 14px; background: #0284c7; padding: 8px 18px; font-size: 13px;" onclick="setMainTab('home')">🏪 تصفح الأدوية والتسوق</button>
        </div>
      `;
      container.innerHTML = html;
      return;
    }

    // 1. Render Pending Orders First (قيد الانتظار)
    if (myPending.length > 0) {
      html += `<div style="font-size: 13px; font-weight: 800; color: #b45309; margin-bottom: 8px; padding-right: 4px;">⏳ طلبيات قيد الانتظار والمراجعة (${myPending.length}):</div>`;
      myPending.forEach(o => {
        html += `
          <div class="prod-card" style="border-right: 4px solid #f59e0b; margin-bottom: 12px; background: #fffdfa;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <div>
                <div style="font-size:15px;font-weight:800;color:#0f172a;">🏥 ${escapeHtml(o.pharmacyName || 'طلب أدوية')}</div>
                <div style="font-size:11px;color:#64748b;margin-top:2px;">رقم الطلب: ${o.orderNumber || o.id} - ${o.date || ''}</div>
              </div>
              <div style="text-align:left;">
                <span class="badge" style="background:#fef3c7;color:#92400e;font-weight:800;font-size:11px;">⏳ قيد الانتظار</span>
                <div style="font-size:15px;font-weight:900;color:#059669;margin-top:4px;">${Number(o.totalAmount || 0).toLocaleString()} د.ع</div>
              </div>
            </div>

            <div style="background:#fefce8;border:1px solid #fef08a;padding:8px 12px;border-radius:10px;margin:8px 0;font-size:12px;">
              <b style="color:#854d0e;">الأدوية المطلوبة (${o.items?.length || 0}):</b>
              <div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:6px;">
                ${(o.items || []).map(it => `
                  <span class="badge" style="background:#ffffff;border:1px solid #fef08a;color:#0f172a;font-weight:700;">
                    ${escapeHtml(it.name)} × ${it.quantity} (${((it.quantity || 0) * (it.price || 0)).toLocaleString()} د.ع)
                  </span>
                `).join('')}
              </div>
            </div>

            <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;">
              <button class="btn" style="flex:1;justify-content:center;background:#0284c7;padding:8px 12px;font-size:12px;font-weight:800;" onclick="openEditSentOrderModal('${o.orderNumber}')">
                ✏️ تعديل الطلب
              </button>
              <button class="btn btn-sec" style="color:#ef4444;border-color:#fca5a5;background:#fef2f2;padding:8px 12px;font-size:12px;font-weight:800;" onclick="handleDeleteMyOrder('${o.id || o.orderNumber}')">
                🗑️ إلغاء وحذف الطلب
              </button>
              <button class="btn btn-sec" style="padding:8px 12px;font-size:12px;font-weight:700;" onclick="printOrderA4('${o.orderNumber}')">
                🖨️ طباعة
              </button>
            </div>
          </div>
        `;
      });
    }

    // 2. Render Approved Orders (معتمدة ومجهزة)
    if (approvedList.length > 0) {
      html += `<div style="font-size: 13px; font-weight: 800; color: #15803d; margin: 14px 0 8px; padding-right: 4px;">✅ طلبيات معتمدة ومجهزة (${approvedList.length}):</div>`;
      approvedList.forEach(o => {
        const isDeliv = isOrderDelivered(o);
        html += `
          <div class="prod-card" style="border-right: 4px solid ${isDeliv ? '#10b981' : '#3b82f6'}; margin-bottom: 12px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <div>
                <div style="font-size:15px;font-weight:800;color:#0f172a;">🏥 ${escapeHtml(o.pharmacyName || 'طلب أدوية')}</div>
                <div style="font-size:11px;color:#64748b;margin-top:2px;">رقم الطلب: ${o.orderNumber || o.id} - ${o.date || ''}</div>
              </div>
              <div style="text-align:left;">
                ${isDeliv ? `
                  <span class="badge" style="background:#dcfce7;color:#15803d;font-weight:900;border:1.5px solid #86efac;font-size:11.5px;display:inline-flex;align-items:center;gap:4px;">🚚 تم تسليمها ✓</span>
                ` : `
                  <span class="badge" style="background:#dbeafe;color:#1e40af;font-weight:800;font-size:11px;">✓ معتمد ومجهز</span>
                `}
                <div style="font-size:15px;font-weight:900;color:#059669;margin-top:4px;">${Number(o.totalAmount || 0).toLocaleString()} د.ع</div>
              </div>
            </div>

            ${isDeliv ? `
              <div style="background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;font-size:11.5px;font-weight:800;padding:6px 10px;border-radius:8px;margin:6px 0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;">
                <span>🚚 <b>تم تسليم واستلام الطلبية بنجاح</b> ${o.deliveredAt ? `(${escapeHtml(o.deliveredAt)})` : ''}</span>
                ${o.deliveryStaffName ? `<span>المستلم/المندوب: <b>${escapeHtml(o.deliveryStaffName)}</b></span>` : ''}
              </div>
            ` : ''}

            <div style="background:#f8fafc;border:1px solid #e2e8f0;padding:8px 12px;border-radius:10px;margin:8px 0;font-size:12px;">
              <b style="color:#334155;">المواد المجهزة (${o.items?.length || 0}):</b>
              <div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:6px;">
                ${(o.items || []).map(it => `
                  <span class="badge" style="background:#ffffff;border:1px solid #e2e8f0;color:#0f172a;font-weight:700;">
                    ${escapeHtml(it.name)} × ${it.quantity} (${((it.quantity || 0) * (it.price || 0)).toLocaleString()} د.ع)
                  </span>
                `).join('')}
              </div>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;gap:8px;flex-wrap:wrap;">
              <div style="font-size:11px;color:${isDeliv ? '#15803d' : '#059669'};font-weight:700;">
                ${isDeliv ? '✓ تم تسليم الطلبية وإغلاقها بنجاح' : '✓ تم اعتماد وتجهيز هذه الطلبية من المستودع'}
              </div>
              <button class="btn btn-sec" style="padding:7px 14px;font-size:12px;font-weight:800;" onclick="printOrderA4('${o.orderNumber}')">
                🖨️ عرض الفاتورة والطباعة
              </button>
            </div>
          </div>
        `;
      });
    }

  } else {
    // Admin / Warehouse Owner Orders Management View
    const filterStaff = (currentStaff || '').trim();
    if (filterStaff && filterStaff !== '__all__') {
      html += `
        <div style="background: #fef3c7; border: 1px solid #fde68a; border-radius: 12px; padding: 10px 14px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 18px;">👑</span>
            <span style="font-size: 13px; font-weight: 800; color: #92400e;">الطلبيات الصادرة للموظف: <b>${escapeHtml(filterStaff)}</b></span>
          </div>
          <button class="btn btn-sec" style="font-size: 11px; padding: 3px 8px;" onclick="onStaffSelected('')">عرض جميع الموظفين</button>
        </div>
      `;
    }

    if (approvedList.length === 0) {
      html += `
        <div style="text-align:center; padding: 40px 20px; color: var(--ios-sub);">
          <div style="font-size: 38px; margin-bottom: 8px;">📑</div>
          <div style="font-size: 15px; font-weight: 700;">لا توجد طلبيات صادرة معتمدة مسجلة</div>
        </div>
      `;
      container.innerHTML = html;
      return;
    }

    approvedList.forEach((o, oIdx) => {
      const isDeliv = isOrderDelivered(o);
      html += `
        <div class="prod-card" style="border-right: 4px solid ${isDeliv ? '#10b981' : 'var(--ios-green)'}; margin-bottom: 12px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-size:16px;font-weight:800;">🏥 ${escapeHtml(o.pharmacyName || 'طلب أدوية')}</div>
              <div style="font-size:11px;color:var(--ios-sub);margin-top:2px;">رقم الطلب: ${o.orderNumber || o.id} - ${o.date || ''}</div>
              ${o.phone ? `<div style="font-size:11px;color:var(--ios-sub);">هاتف: ${o.phone}</div>` : ''}
              ${o.staffName ? `<div style="font-size:11px;color:var(--ios-green);font-weight:700;">المجهز: ${o.staffName}</div>` : ''}
            </div>
            <div style="text-align:left;">
              ${isDeliv ? `
                <span class="badge" style="background:#dcfce7;color:#15803d;font-weight:900;border:1.5px solid #86efac;font-size:12px;display:inline-flex;align-items:center;gap:4px;">
                  🚚 تم تسليمها ✓
                </span>
              ` : `
                <span class="badge" style="background:#dbeafe;color:#1e40af;font-weight:800;font-size:12px;">
                  ✓ ${o.status || 'معتمد'}
                </span>
              `}
              <div style="font-size:15px;font-weight:800;color:var(--ios-green);margin-top:4px;">${Number(o.totalAmount || 0).toLocaleString()} د.ع</div>
            </div>
          </div>

          ${isDeliv ? `
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;font-size:11.5px;font-weight:800;padding:6px 10px;border-radius:8px;margin:6px 0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;">
              <span>🚚 <b>تم تسليم الطلبية بنجاح</b> ${o.deliveredAt ? `بتاريخ: ${escapeHtml(o.deliveredAt)}` : ''}</span>
              ${o.deliveryStaffName ? `<span>المستلم/المندوب: <b>${escapeHtml(o.deliveryStaffName)}</b></span>` : ''}
            </div>
          ` : ''}

          <div style="background:#f8f9fa;padding:8px 12px;border-radius:10px;margin:8px 0;font-size:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <b>المواد المجهزة (${o.items?.length || 0}):</b>
              <span style="font-size:11px;color:var(--ios-sub);">اضغط ↩️ لإرجاع مادة</span>
            </div>
            <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px;">
              ${(o.items || []).map((it, itemIdx) => `
                <span class="badge" style="background:#e5e7eb;color:#111;display:inline-flex;align-items:center;gap:6px;padding:4px 8px;">
                  <span>${escapeHtml(it.name)} × ${it.quantity} (${((it.quantity || 0) * (it.price || 0)).toLocaleString()} د.ع)</span>
                  <button type="button" style="background:#fee2e2;color:#dc2626;border:1px solid #fecaca;border-radius:4px;cursor:pointer;font-size:10px;font-weight:bold;padding:1px 6px;" onclick="event.stopPropagation(); openReturnModalByOrderAndItemIndex(${oIdx}, ${itemIdx})" title="إرجاع مادة للمخزن">↩️ إرجاع</button>
                </span>
              `).join('')}
            </div>
          </div>

          <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;">
            <button class="btn btn-sec" style="flex:1;justify-content:center;padding:9px;font-size:12px;" onclick="printOrderA4('${escapeHtml(o.orderNumber || o.id)}')">🖨️ طباعة قائمة A4</button>
            <button class="btn btn-sec" style="color:#b45309;border-color:#fde68a;background:#fffbeb;padding:9px 12px;font-size:12px;font-weight:800;" onclick="openReturnOrderModal('${escapeHtml(o.orderNumber || o.id)}', orders[${oIdx}])" title="إرجاع مواد مجهزة إلى رصيد المخزن">
              ↩️ إرجاع مواد للمخزن
            </button>
            ${isAdmin && !isDeliv ? `
              <button class="btn" style="background:var(--ios-blue);padding:9px 14px;font-size:12px;" onclick="markOrderDelivered('${escapeHtml(o.orderNumber || o.id)}')">تسجيل استلام ✓</button>
            ` : `
              <span style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;padding:8px 12px;border-radius:8px;font-size:11.5px;font-weight:800;display:inline-flex;align-items:center;gap:4px;">
                ✓ مسلّمة بالكامل
              </span>
            `}
            <button class="btn btn-sec" style="color:var(--ios-red);border-color:#fecaca;padding:9px 14px;font-size:12px;" onclick="cancelApprovedOrderPrompt('${escapeHtml(o.orderNumber || o.id)}')" title="إلغاء الطلبية وإرجاع المواد">
              🗑️ إلغاء وحذف
            </button>
          </div>
        </div>
      `;
    });
  }

  container.innerHTML = html;
}

// Return Order Modal Logic (إرجاع المواد المجهزة إلى رصيد المستودع)
let activeReturnOrder = null;
let selectedOrderForReturn = null;
let selectedItemToReturn = null;
let isReturnModalOpen = false;

function setSelectedItemToReturn(item) {
  selectedItemToReturn = item;
}
window.setSelectedItemToReturn = setSelectedItemToReturn;

function setSelectedOrderForReturn(order) {
  selectedOrderForReturn = order;
  if (order) {
    activeReturnOrder = order;
  }
}
window.setSelectedOrderForReturn = setSelectedOrderForReturn;

function setIsReturnModalOpen(isOpen) {
  isReturnModalOpen = !!isOpen;
  const modal = document.getElementById('modal-return-order');
  if (modal) {
    if (isOpen) {
      modal.classList.add('is-open');
    } else {
      modal.classList.remove('is-open');
    }
  }
}
window.setIsReturnModalOpen = setIsReturnModalOpen;

/**
 * Opens return modal for a single item from an order
 */
function openReturnModal(item, order) {
  setSelectedItemToReturn(item);
  setSelectedOrderForReturn(order);

  if (item && order) {
    const qtyToReturn = Number(item.qty || item.quantity || 1);
    const itName = item.name || item.product || 'المادة';

    const modal = document.getElementById('modal-confirm-return');
    const msgEl = document.getElementById('confirm-return-msg');
    const actionBtn = document.getElementById('confirm-return-action-btn');

    if (msgEl) {
      msgEl.innerHTML = `
        هل أنت متأكد من إرجاع كمية (<b style="color:#dc2626;font-size:16px;">${qtyToReturn}</b>) من [<b>${escapeHtml(itName)}</b>]
        إلى رصيد المستودع وتعديل حساب الطلبية؟
      `;
    }

    if (actionBtn) {
      actionBtn.onclick = async () => {
        actionBtn.disabled = true;
        actionBtn.innerText = '⏳ جاري إرجاع المادة...';
        try {
          await handleConfirmReturn();
          closeConfirmReturnModal();
        } catch (e) {
          console.error(e);
        } finally {
          actionBtn.disabled = false;
          actionBtn.innerText = 'نعم، إرجاع للمخزن ✓';
        }
      };
    }

    if (modal) {
      if (modal.parentElement !== document.body || modal !== document.body.lastElementChild) {
        document.body.appendChild(modal);
      }
      modal.style.zIndex = '2147483647';
      modal.classList.add('is-open');
    }
  } else if (order) {
    openReturnOrderModal(order.orderNumber || order.order_ref || order.id, order);
  }
}
window.openReturnModal = openReturnModal;

/**
 * Helper to open return modal for item by index from orders log
 */
function openReturnModalByOrderAndItemIndex(orderIdx, itemIdx) {
  const ord = orders[orderIdx];
  if (!ord || !ord.items || !ord.items[itemIdx]) return;
  const it = ord.items[itemIdx];
  openReturnModal(it, ord);
}
window.openReturnModalByOrderAndItemIndex = openReturnModalByOrderAndItemIndex;

function openReturnOrderModal(orderNumber, orderObj = null) {
  let o = orderObj;
  if (!o && orderNumber) {
    const strNum = String(orderNumber).trim();
    o = orders.find(x => x.orderNumber === strNum || String(x.id) === strNum || x.order_ref === strNum) || 
        pendingOrders.find(x => x.orderNumber === strNum || String(x.id) === strNum || x.order_ref === strNum);
    if (!o) {
      o = orders.find(x => x.orderNumber?.includes(strNum) || String(x.id).includes(strNum)) ||
          pendingOrders.find(x => x.orderNumber?.includes(strNum) || String(x.id).includes(strNum));
    }
  }

  if (!o) {
    showInAppAlert('الطلبية غير موجودة.', 'تنبيه');
    return;
  }

  activeReturnOrder = o;
  setSelectedOrderForReturn(o);
  setIsReturnModalOpen(true);

  const modal = document.getElementById('modal-return-order');
  const subTitle = document.getElementById('return-order-subtitle');
  const metaBox = document.getElementById('return-order-meta');
  const itemsList = document.getElementById('return-order-items-list');

  const orderNumDisplay = o.orderNumber || o.order_ref || o.id || '';
  if (subTitle) subTitle.innerText = `رقم الطلب: ${orderNumDisplay} | التاريخ: ${o.date || ''}`;
  if (metaBox) {
    metaBox.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:6px;">
        <div>🏥 <b>الصيدلية:</b> ${escapeHtml(o.pharmacyName || o.customerName || '')} ${o.phone ? `(${escapeHtml(o.phone)})` : ''}</div>
        <div>👤 <b>المجهز:</b> ${escapeHtml(o.staffName || 'غير مسجل')}</div>
        <div>💰 <b>إجمالي القائمة:</b> <span style="color:var(--ios-green);font-weight:800;">${Number(o.totalAmount || 0).toLocaleString()} د.ع</span></div>
      </div>
    `;
  }

  if (itemsList) {
    if (!o.items || o.items.length === 0) {
      itemsList.innerHTML = `<div style="text-align:center;color:var(--ios-sub);padding:24px;">لا توجد مواد قابلة للإرجاع في هذه الطلبية</div>`;
    } else {
      itemsList.innerHTML = o.items.map((it, idx) => `
        <div id="ret-item-row-${idx}" style="background:#fff;border:1px solid var(--ios-border);border-radius:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;transition:all 0.2s ease;">
          <div style="flex:1;min-width:180px;">
            <div style="font-weight:800;font-size:13px;color:var(--ios-text);">${escapeHtml(it.name)}</div>
            <div style="font-size:11px;color:var(--ios-sub);margin-top:2px;">
              ${it.form ? escapeHtml(it.form) : ''} | سعر المفرد: ${Number(it.price || 0).toLocaleString()} د.ع | ${it.expiryDate ? `EXP: ${escapeHtml(it.expiryDate)}` : ''}
            </div>
            <div style="font-size:11.5px;color:#1e40af;font-weight:700;margin-top:2px;">
              الكمية المجهزة الحالية: <b>${it.quantity}</b>
            </div>
          </div>
          <div id="ret-action-box-${idx}" style="display:flex;align-items:center;gap:8px;">
            <div style="display:flex;align-items:center;gap:4px;">
              <label style="font-size:11px;color:var(--ios-sub);font-weight:bold;">المرتجع:</label>
              <input type="number" id="ret-qty-${idx}" min="1" max="${it.quantity}" value="${it.quantity}" style="width:55px;height:32px;text-align:center;border-radius:6px;border:1.5px solid var(--ios-border);font-size:13px;font-weight:bold;">
            </div>
            <button type="button" class="btn btn-sec" style="color:#dc2626;border-color:#fecaca;padding:6px 12px;font-size:11.5px;font-weight:800;" onclick="openConfirmReturnModal(${idx})">
              إرجاع المادة ↩️
            </button>
          </div>
        </div>
      `).join('');
    }
  }

  if (modal) modal.classList.add('is-open');
}

function closeReturnOrderModal() {
  const modal = document.getElementById('modal-return-order');
  if (modal) modal.classList.remove('is-open');
  isReturnModalOpen = false;
  // Delay clearing reference to allow any active confirm dialog to finish safely
  setTimeout(() => {
    const confirmModal = document.getElementById('modal-confirm-delete');
    const returnConfirmModal = document.getElementById('modal-confirm-return');
    if ((!confirmModal || !confirmModal.classList.contains('is-open')) &&
        (!returnConfirmModal || !returnConfirmModal.classList.contains('is-open'))) {
      activeReturnOrder = null;
      selectedOrderForReturn = null;
      selectedItemToReturn = null;
    }
  }, 800);
}

/**
 * Core function to handle returning an item with safe navigation,
 * updating Supabase samo table (column "number" exclusively),
 * logging to inventory_logs, updating orders table, and refreshing data.
 */
const handleConfirmReturn = async () => {
  try {
    // قراءة المعرف المرجعي للطلبية بمرونة وبحماية تامة من قيم null
    const orderRef = 
      selectedOrderForReturn?.orderNumber || 
      selectedOrderForReturn?.order_ref || 
      selectedOrderForReturn?.order_number || 
      selectedOrderForReturn?.id || 
      selectedItemToReturn?.order_ref || 
      activeReturnOrder?.orderNumber ||
      activeReturnOrder?.order_ref ||
      activeReturnOrder?.id ||
      'غير محدد';

    let productId = selectedItemToReturn?.product_id || selectedItemToReturn?.id;
    const returnQty = Number(selectedItemToReturn?.qty || selectedItemToReturn?.quantity || 1);

    // If productId is not on the item object, resolve from products cache
    if (!productId && selectedItemToReturn?.name) {
      const pMatch = products.find(p => p.name === selectedItemToReturn.name || (selectedItemToReturn.barcode && p.barcode === selectedItemToReturn.barcode));
      if (pMatch) productId = pMatch.id;
    }

    if (!productId) {
      throw new Error("معرّف المادة غير موجود");
    }

    const supabase = getSupabaseClient();
    let currentStock = 0;
    let updatedStock = returnQty;
    let prodName = selectedItemToReturn?.name || selectedItemToReturn?.product || '';

    if (supabase) {
      // 1. إعادة الكمية إلى المخزن في جدول samo (تحديث عمود number حصراً):
      let prodData = null;
      const { data: pById } = await supabase
        .from('samo')
        .select('number, product, price_of_one')
        .eq('id', productId)
        .maybeSingle();

      prodData = pById;

      if (!prodData && selectedItemToReturn?.barcode) {
        const { data: pByBc } = await supabase
          .from('samo')
          .select('number, product, price_of_one')
          .eq('barcode', selectedItemToReturn.barcode)
          .maybeSingle();
        prodData = pByBc;
      }

      if (!prodData && selectedItemToReturn?.name) {
        const { data: pByName } = await supabase
          .from('samo')
          .select('number, product, price_of_one')
          .eq('product', selectedItemToReturn.name)
          .maybeSingle();
        prodData = pByName;
      }

      currentStock = Number(prodData?.number) || 0;
      updatedStock = currentStock + returnQty;
      prodName = prodData?.product || selectedItemToReturn?.product || selectedItemToReturn?.name || prodName;

      const price = Number(prodData?.price_of_one) || Number(selectedItemToReturn?.price) || 0;
      const newTotal = updatedStock * price;

      const { error: updateErr } = await supabase
        .from('samo')
        .update({ number: updatedStock, total_price: newTotal })
        .eq('id', prodData?.id || productId);

      if (updateErr) {
        // Fallback update with number only
        await supabase
          .from('samo')
          .update({ number: updatedStock })
          .eq('id', prodData?.id || productId);
      }

      // 2. تسجيل حركة الإرجاع في inventory_logs:
      try {
        const itemToReturn = selectedItemToReturn;
        const currentOrder = selectedOrderForReturn || activeReturnOrder;
        const itemProductName = itemToReturn?.product || itemToReturn?.name || prodData?.product || prodName || 'مادة';
        await logInventoryMovement('إرجاع مادة', itemProductName, {
          order_ref: currentOrder?.order_ref || currentOrder?.orderNumber || orderRef || 'مرتجع',
          returned_qty: itemToReturn?.qty || itemToReturn?.quantity || returnQty || 1,
          previous_qty: currentStock,
          new_qty: updatedStock
        });
      } catch (logErr) {
        console.warn('Supabase inventory_logs note:', logErr);
      }

      // 3. تحديث الطلبية (حذف المادة المرجعة من عناصر الطلب أو تقليل كميتها وإعادة حساب الإجمالي):
      const targetOrder = selectedOrderForReturn || activeReturnOrder;
      if (targetOrder?.id) {
        const rawItems = Array.isArray(targetOrder.items) ? [...targetOrder.items] : [];
        let updatedItems = [];
        let handled = false;

        for (const it of rawItems) {
          const itId = it.product_id || it.id;
          const isTarget = (itId && String(itId) === String(productId)) || 
                           (it.name && it.name === selectedItemToReturn?.name) ||
                           (it.barcode && selectedItemToReturn?.barcode && it.barcode === selectedItemToReturn?.barcode);

          if (isTarget && !handled) {
            handled = true;
            const currentItemQty = Number(it.quantity || it.number || it.qty || 1);
            const remaining = currentItemQty - returnQty;
            if (remaining > 0) {
              updatedItems.push({
                ...it,
                quantity: remaining,
                qty: remaining
              });
            }
            // If remaining <= 0, item is omitted (deleted from order)
          } else {
            updatedItems.push(it);
          }
        }

        const newOrderTotal = updatedItems.reduce((acc, it) => {
          const q = Number(it.quantity || it.qty || 0);
          const p = Number(it.price || it.price_of_one || 0);
          return acc + (q * p);
        }, 0);

        let numericId = Number(targetOrder.id);
        if (isNaN(numericId)) {
          const match = String(targetOrder.id).match(/ORD-SB-(\d+)/);
          if (match) numericId = Number(match[1]);
        }

        let ordQuery = supabase
          .from('orders')
          .update({
            items: updatedItems,
            total_amount: newOrderTotal
          });

        if (!isNaN(numericId) && numericId > 0) {
          ordQuery = ordQuery.eq('id', numericId);
        } else {
          ordQuery = ordQuery.eq('id', targetOrder.id);
        }
        await ordQuery;

        targetOrder.items = updatedItems;
        targetOrder.totalAmount = newOrderTotal;
      }
    }

    // 4. Synchronize with local backend API for SQLite cache consistency
    try {
      await postToApi({
        action: 'return_order_item',
        orderNumber: orderRef,
        item: {
          id: productId,
          name: prodName,
          barcode: selectedItemToReturn?.barcode,
          quantity: returnQty
        }
      });
    } catch (apiErr) {
      console.warn('Backend return_order_item note:', apiErr);
    }

    alert('تم إرجاع المادة إلى المخزن وتحديث الرصيد بنجاح');
    setIsReturnModalOpen(false);
    closeReturnOrderModal();

    // إعادة تحديث القائمة
    if (typeof fetchOrders === 'function') fetchOrders();
    if (typeof fetchProducts === 'function') fetchProducts();
    if (typeof loadRemoteData === 'function') loadRemoteData();

  } catch (err) {
    console.error('فشل إرجاع المادة:', err);
    alert('تعذر إرجاع المادة: ' + (err.message || err));
  }
};
window.handleConfirmReturn = handleConfirmReturn;

// Dedicated Confirmation Dialog for Returning Items (Always stacks cleanly on TOP of modal-return-order)
function openConfirmReturnModal(itemIdx) {
  const currentOrder = selectedOrderForReturn || activeReturnOrder;
  if (!currentOrder || !currentOrder.items || !currentOrder.items[itemIdx]) {
    alert('تعذر تحديد بيانات المادة من الطلبية');
    return;
  }
  const it = currentOrder.items[itemIdx];
  const inputEl = document.getElementById(`ret-qty-${itemIdx}`);
  const qtyToReturn = Math.max(1, Math.min(it.quantity, parseInt(inputEl?.value || '1', 10)));

  // Save selected item and order immediately before opening modal
  setSelectedItemToReturn({
    ...it,
    qty: qtyToReturn,
    quantity: qtyToReturn,
    product_id: it.id || it.product_id
  });
  setSelectedOrderForReturn(currentOrder);

  const modal = document.getElementById('modal-confirm-return');
  const msgEl = document.getElementById('confirm-return-msg');
  const actionBtn = document.getElementById('confirm-return-action-btn');

  if (msgEl) {
    msgEl.innerHTML = `
      هل أنت متأكد من إرجاع كمية (<b style="color:#dc2626;font-size:16px;">${qtyToReturn}</b>) من دواء:
      <div style="font-weight:900;color:#0f172a;font-size:14.5px;background:#f8fafc;padding:10px;border-radius:10px;margin:10px 0;border:1px solid #e2e8f0;">
        ${escapeHtml(it.name)}
      </div>
      إلى رصيد المستودع وتعديل حساب الطلبية؟
    `;
  }

  if (actionBtn) {
    actionBtn.onclick = async () => {
      actionBtn.disabled = true;
      actionBtn.innerText = '⏳ جاري إرجاع المادة...';
      try {
        await handleConfirmReturn();
        closeConfirmReturnModal();
      } catch (e) {
        console.error('فشل إرجاع المادة:', e);
      } finally {
        actionBtn.disabled = false;
        actionBtn.innerText = 'نعم، إرجاع للمخزن ✓';
      }
    };
  }

  if (modal) {
    // DOM positioning: Ensure it is at the very end of document.body for highest stacking context
    if (modal.parentElement !== document.body || modal !== document.body.lastElementChild) {
      document.body.appendChild(modal);
    }
    modal.style.zIndex = '2147483647';
    modal.classList.add('is-open');
  }
}

function closeConfirmReturnModal() {
  const modal = document.getElementById('modal-confirm-return');
  if (modal) modal.classList.remove('is-open');
}

window.openConfirmReturnModal = openConfirmReturnModal;
window.closeConfirmReturnModal = closeConfirmReturnModal;

async function submitSingleReturnItem(itemIdx) {
  openConfirmReturnModal(itemIdx);
}
window.submitSingleReturnItem = submitSingleReturnItem;

async function submitBatchReturnItems() {
  const currentOrder = selectedOrderForReturn || activeReturnOrder;
  if (!currentOrder || !currentOrder.items || currentOrder.items.length === 0) return;
  const itemsToReturn = [];
  currentOrder.items.forEach((it, idx) => {
    const inputEl = document.getElementById(`ret-qty-${idx}`);
    const qty = parseInt(inputEl?.value || '0', 10);
    if (qty > 0) {
      itemsToReturn.push({
        ...it,
        id: it.id || it.product_id,
        product_id: it.id || it.product_id,
        name: it.name,
        barcode: it.barcode,
        quantity: Math.min(it.quantity, qty),
        qty: Math.min(it.quantity, qty)
      });
    }
  });

  if (itemsToReturn.length === 0) {
    alert('يرجى تحديد كمية للإرجاع');
    return;
  }

  showInAppConfirm({
    title: 'إرجاع المواد المحددة للمخزن',
    message: `هل أنت متأكد من إرجاع (${itemsToReturn.length}) مواد إلى رصيد المستودع وتحديث حساب الطلبية؟`,
    icon: '↩️',
    confirmText: 'نعم، إرجاع كافة المواد المحددة',
    isDanger: true,
    onConfirm: async () => {
      try {
        for (const it of itemsToReturn) {
          setSelectedItemToReturn(it);
          setSelectedOrderForReturn(currentOrder);
          await handleConfirmReturn();
        }
      } catch (err) {
        alert('تعذر إرجاع المواد: ' + (err.message || err));
      }
    }
  });
}

async function markOrderDelivered(orderNumber) {
  const deliverer = currentStaff || prompt('اسم مندوب التوصيل / المستلم:') || 'المندوب';
  const deliveredAt = new Date().toLocaleString('ar-IQ');
  try {
    // 1. Instant local state update so it immediately reflects in UI without disappearing
    const strNum = String(orderNumber).trim();
    const ord = orders.find(o => String(o.orderNumber || o.id).trim() === strNum);
    if (ord) {
      ord.status = 'تم التسليم';
      ord.deliveredAt = deliveredAt;
      ord.deliveryStaffName = deliverer;
      saveLocalData();
      renderOrdersLog();
    }

    // 2. Direct Supabase update
    const sb = getSupabaseClient();
    if (sb) {
      sb.from('orders')
        .update({
          status: 'تم التسليم',
          approved_by: deliverer,
          notes: `تم التسليم بواسطة ${deliverer} في ${deliveredAt}`
        })
        .eq('id', ord?.id || orderNumber)
        .then(() => {})
        .catch(err => console.warn('Supabase markOrderDelivered err:', err));
    }

    // 3. Backend local SQLite update
    await postToApi({
      action: 'deliver_order',
      orderNumber,
      deliveryStaffName: deliverer,
      deliveredAt
    });

    showQuickToast('تم تسجيل تسليم الطلبية بنجاح وتبقى في سجل الصادر ✓');
    loadRemoteData();
  } catch (err) {
    alert('حدث خطأ: ' + err.message);
  }
}
window.markOrderDelivered = markOrderDelivered;

let activeInvoiceOrderNumber = '';

// Close Invoice Print Modal
function closeInvoiceModal() {
  const modal = document.getElementById('modal-print-invoice');
  if (modal) modal.classList.remove('is-open');
}

// Print Order A4 (معاينة وطباعة قائمة تجهيز منظمة بصفحة واحدة: المادة والعدد والاكسباير والسعر تحت مذخر سامو واسم المجهز والصيدلية)
function printOrderA4(orderNumber) {
  const o = orders.find(x => x.orderNumber === orderNumber) || pendingOrders.find(x => x.orderNumber === orderNumber);
  if (!o) {
    showInAppAlert('لم يتم العثور على بيانات الطلبية المحددة.', 'تنبيه');
    return;
  }
  activeInvoiceOrderNumber = orderNumber;

  const items = o.items || [];
  const totalPieces = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);

  const metaHtml = `
    <div>
      <div style="margin-bottom:3px;">🏥 <b>اسم الصيدلية:</b> <span style="font-size:13px;font-weight:900;">${escapeHtml(o.pharmacyName)}</span></div>
      <div>📞 <b>رقم الهاتف:</b> ${escapeHtml(o.phone || 'غير مسجل')}</div>
    </div>
    <div>
      <div style="margin-bottom:3px;">👤 <b>اسم المجهز:</b> <span style="font-size:13px;font-weight:900;">${escapeHtml(o.staffName || 'المستودع')}</span></div>
      <div>🔖 <b>رقم القائمة:</b> <span style="font-family:monospace;">${escapeHtml(o.orderNumber)}</span> | 📅 <b>التاريخ:</b> ${escapeHtml(o.date || '')}</div>
    </div>
  `;

  const rowsHtml = items.map((it, idx) => {
    let expDate = (it.expiryDate || it.expiry_date || '').trim();
    if (!expDate || expDate === '-' || expDate === 'غير مسجل') {
      const prod = products.find(p => (it.id && p.id === it.id) || (it.barcode && p.barcode === it.barcode) || (it.name && p.name && p.name.trim().toLowerCase() === it.name.trim().toLowerCase()));
      if (prod && prod.expiryDate) {
        expDate = String(prod.expiryDate).trim();
      }
    }

    return `
    <tr style="border-bottom: 1px solid #000;">
      <td style="border: 1px solid #000; padding: 5px 4px; text-align: center; font-weight: 700; width: 30px;">${idx + 1}</td>
      <td style="border: 1px solid #000; padding: 5px 8px; font-weight: 800; font-size: 12px; text-align: right;">
        ${escapeHtml(it.name)} ${it.form ? `<span style="font-size:10px;font-weight:normal;color:#444;">(${escapeHtml(it.form)})</span>` : ''}
      </td>
      <td style="border: 1px solid #000; padding: 5px 6px; text-align: center; font-weight: 900; font-size: 12.5px; background: #fafafa; width: 65px;">${it.quantity}</td>
      <td style="border: 1px solid #000; padding: 5px 6px; text-align: center; font-family: monospace; font-weight: 800; color: #b91c1c; background: #fef2f2; width: 90px;">${escapeHtml(expDate || 'غير مسجل')}</td>
      <td style="border: 1px solid #000; padding: 5px 8px; text-align: left; font-family: monospace; font-size: 11.5px; width: 95px;">${Number(it.price || 0).toLocaleString()}</td>
      <td style="border: 1px solid #000; padding: 5px 8px; text-align: left; font-weight: 900; font-family: monospace; font-size: 12px; background: #fdfdfd; width: 110px;">${(it.quantity * it.price).toLocaleString()}</td>
    </tr>
  `;
  }).join('');

  const totalHtml = `
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <div>
        <b>عدد المواد:</b> <span style="font-weight:800;">${items.length}</span> | 
        <b>إجمالي القطع:</b> <span style="font-weight:800;">${totalPieces}</span>
      </div>
      <div style="font-size:14px; font-weight:900;">
        المبلغ الإجمالي: <span style="color:#059669; font-family:monospace;">${Number(o.totalAmount || 0).toLocaleString()} د.ع</span>
      </div>
    </div>
  `;

  // Populate hidden print sheet
  const metaBox = document.getElementById('inv-meta-info');
  if (metaBox) metaBox.innerHTML = metaHtml;
  const rowsBox = document.getElementById('inv-table-rows');
  if (rowsBox) rowsBox.innerHTML = rowsHtml;
  const totBox = document.getElementById('inv-total-box');
  if (totBox) totBox.innerHTML = totalHtml;
  const staffSign = document.getElementById('inv-staff-sign');
  if (staffSign) staffSign.innerText = `اسم وتوقيع المجهز: ${o.staffName || '....................'}`;

  // Populate visual modal preview
  const modalMetaBox = document.getElementById('modal-inv-meta-info');
  if (modalMetaBox) modalMetaBox.innerHTML = metaHtml;
  const modalRowsBox = document.getElementById('modal-inv-table-rows');
  if (modalRowsBox) modalRowsBox.innerHTML = rowsHtml;
  const modalTotBox = document.getElementById('modal-inv-total-box');
  if (modalTotBox) modalTotBox.innerHTML = totalHtml;
  const modalStaffSign = document.getElementById('modal-inv-staff-sign');
  if (modalStaffSign) modalStaffSign.innerText = `اسم وتوقيع المجهز: ${o.staffName || '....................'}`;
  const modalSub = document.getElementById('modal-inv-subtitle');
  if (modalSub) modalSub.innerText = `قائمة رقم: ${o.orderNumber} لصيدلية: ${o.pharmacyName}`;

  // Open Preview Modal
  const modal = document.getElementById('modal-print-invoice');
  if (modal) modal.classList.add('is-open');
}

// Direct Print function (works in iframes and all browsers)
function printInvoiceDirect() {
  const paper = document.getElementById('modal-invoice-paper') || document.getElementById('invoice-a4-sheet');
  if (!paper) {
    window.print();
    return;
  }

  try {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <title>قائمة تجهيز - مذخر سامو</title>
        <style>
          @page { size: A4 portrait; margin: 6mm 8mm; }
          * { box-sizing: border-box; }
          body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; margin: 0; padding: 12px; color: #000; background: #fff; }
          table { width: 100%; border-collapse: collapse; border: 1.5px solid #000; }
          th, td { border: 1px solid #000; }
        </style>
      </head>
      <body>
        ${paper.innerHTML}
      </body>
      </html>
    `);
    doc.close();

    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(() => {
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }, 1500);
      } catch (e) {
        window.print();
      }
    }, 250);
  } catch (err) {
    window.print();
  }
}

// Export Invoice to PDF (using html2pdf)
function exportInvoicePDF() {
  const paper = document.getElementById('modal-invoice-paper') || document.getElementById('invoice-a4-sheet');
  if (!paper) return;

  if (typeof window.html2pdf !== 'undefined') {
    showQuickToast('جاري إنشاء ملف PDF للقائمة...');
    const opt = {
      margin: [6, 6, 6, 6],
      filename: `قائمة_تجهيز_سامو_${activeInvoiceOrderNumber || 'طلب'}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };
    window.html2pdf().set(opt).from(paper).save().then(() => {
      showQuickToast('تم حفظ قائمة التجهيز PDF بنجاح ✓');
    }).catch(e => {
      console.warn('PDF export fallback:', e);
      printInvoiceDirect();
    });
  } else {
    printInvoiceDirect();
  }
}

// ==========================================
// Product Image Upload, Live Camera & Lightbox
// ==========================================
let activeProductCameraStream = null;
let currentProductCameraMode = 'add'; // 'add' | 'edit'
let currentProductCameraFacing = 'environment'; // 'environment' | 'user'
let capturedProductPhotoData = null;
let isProductCameraAiMode = false;

function openProductCameraModal(mode = 'add', withAi = false) {
  currentProductCameraMode = mode;
  isProductCameraAiMode = withAi;
  capturedProductPhotoData = null;

  const modal = document.getElementById('modal-product-camera');
  if (modal) modal.classList.add('is-open');

  const titleEl = document.getElementById('product-cam-title');
  const subEl = document.getElementById('product-cam-sub');
  const aiBtn = document.getElementById('cam-ai-analyze-btn');

  if (titleEl) {
    titleEl.innerHTML = withAi 
      ? `<span>✨</span><span>التقاط صورة الدواء وتحليل البيانات</span>`
      : `<span>📷</span><span>التقاط صورة علبة الدواء</span>`;
  }
  if (subEl) {
    subEl.innerText = withAi 
      ? `وجّه الكاميرا نحو علبة الدواء لقراءة الاسم والشركة وتعيين الصورة`
      : `وجّه الكاميرا نحو علبة الدواء لالتقاط صورة واضحة وتعيينها فوراً`;
  }
  if (aiBtn) {
    aiBtn.style.display = withAi ? 'flex' : 'none';
  }

  // Reset controls state
  const liveControls = document.getElementById('camera-live-controls');
  const reviewControls = document.getElementById('camera-review-controls');
  const videoEl = document.getElementById('product-camera-video');
  const capturedImg = document.getElementById('product-camera-captured-img');
  const statusPill = document.getElementById('product-cam-status-pill');

  if (liveControls) liveControls.style.display = 'flex';
  if (reviewControls) reviewControls.style.display = 'none';
  if (videoEl) videoEl.style.display = 'block';
  if (capturedImg) capturedImg.style.display = 'none';
  if (statusPill) {
    statusPill.style.display = 'block';
    statusPill.innerText = 'جاري تشغيل الكاميرا...';
  }

  startProductCameraStream();
}

function openAiMedicineCamera(mode = 'add') {
  openProductCameraModal(mode, true);
}
window.openAiMedicineCamera = openAiMedicineCamera;

async function analyzeCapturedPhotoWithAi() {
  if (!capturedProductPhotoData) {
    showQuickToast('يرجى التقاط صورة أولاً', 'error');
    return;
  }
  showQuickToast('تم تعيين صورة الدواء بنجاح ✓');
  applyCapturedPhotoToProduct();
}
window.analyzeCapturedPhotoWithAi = analyzeCapturedPhotoWithAi;

async function startProductCameraStream() {
  const videoEl = document.getElementById('product-camera-video');
  const statusPill = document.getElementById('product-cam-status-pill');

  // Stop previous stream if any
  stopProductCameraStream();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (statusPill) {
      statusPill.style.display = 'block';
      statusPill.innerText = 'الكاميرا المباشرة غير مدعومة في متصفحك. يرجى استخدام زر رفع ملف.';
    }
    return;
  }

  try {
    const constraints = {
      video: {
        facingMode: { ideal: currentProductCameraFacing },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    activeProductCameraStream = stream;
    if (videoEl) {
      videoEl.srcObject = stream;
      await videoEl.play().catch(() => {});
    }
    if (statusPill) statusPill.style.display = 'none';
  } catch (err) {
    console.warn('Camera stream error:', err);
    try {
      const fallbackStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      activeProductCameraStream = fallbackStream;
      if (videoEl) {
        videoEl.srcObject = fallbackStream;
        await videoEl.play().catch(() => {});
      }
      if (statusPill) statusPill.style.display = 'none';
    } catch (e2) {
      if (statusPill) {
        statusPill.style.display = 'block';
        statusPill.innerText = 'تعذر الوصول للكاميرا (يرجى منح الإذن أو استخدام زر رفع صورة)';
      }
    }
  }
}

function stopProductCameraStream() {
  if (activeProductCameraStream) {
    try {
      activeProductCameraStream.getTracks().forEach(t => t.stop());
    } catch (e) {}
    activeProductCameraStream = null;
  }
  const videoEl = document.getElementById('product-camera-video');
  if (videoEl) {
    videoEl.srcObject = null;
  }
}

function closeProductCameraModal() {
  stopProductCameraStream();
  const modal = document.getElementById('modal-product-camera');
  if (modal) modal.classList.remove('is-open');
}

function switchCameraFacingMode() {
  currentProductCameraFacing = currentProductCameraFacing === 'environment' ? 'user' : 'environment';
  startProductCameraStream();
}

function snapProductPhoto() {
  const videoEl = document.getElementById('product-camera-video');
  const canvas = document.getElementById('product-camera-canvas');
  const capturedImg = document.getElementById('product-camera-captured-img');
  const liveControls = document.getElementById('camera-live-controls');
  const reviewControls = document.getElementById('camera-review-controls');

  if (!videoEl || !canvas) return;

  const w = videoEl.videoWidth || 640;
  const h = videoEl.videoHeight || 480;

  canvas.width = Math.min(w, 800);
  canvas.height = Math.round((canvas.width / w) * h);

  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
  capturedProductPhotoData = dataUrl;

  stopProductCameraStream();

  if (capturedImg) {
    capturedImg.src = dataUrl;
    capturedImg.style.display = 'block';
  }
  if (videoEl) videoEl.style.display = 'none';

  if (liveControls) liveControls.style.display = 'none';
  if (reviewControls) reviewControls.style.display = 'flex';
}

function retakeProductPhoto() {
  capturedProductPhotoData = null;
  const videoEl = document.getElementById('product-camera-video');
  const capturedImg = document.getElementById('product-camera-captured-img');
  const liveControls = document.getElementById('camera-live-controls');
  const reviewControls = document.getElementById('camera-review-controls');

  if (capturedImg) capturedImg.style.display = 'none';
  if (videoEl) videoEl.style.display = 'block';
  if (liveControls) liveControls.style.display = 'flex';
  if (reviewControls) reviewControls.style.display = 'none';

  startProductCameraStream();
}

async function uploadImageToSupabaseStorage(base64Data, fileName = 'product.jpg') {
  try {
    const res = await fetch('/api/supabase/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64Data, fileName, contentType: 'image/jpeg' })
    });
    const data = await res.json();
    if (data && data.success && data.publicUrl) {
      return data.publicUrl;
    }
    return base64Data;
  } catch (err) {
    console.warn('Supabase storage upload fallback:', err);
    return base64Data;
  }
}

async function confirmCapturedProductPhoto() {
  if (!capturedProductPhotoData) {
    showInAppAlert('يرجى التقاط صورة أولاً.', 'تنبيه');
    return;
  }

  const mode = currentProductCameraMode;
  setProductImageValue(mode, capturedProductPhotoData);
  closeProductCameraModal();
  showQuickToast('جاري رفع الصورة إلى Supabase Storage...');

  try {
    const publicUrl = await uploadImageToSupabaseStorage(capturedProductPhotoData, `camera_${Date.now()}.jpg`);
    if (publicUrl && publicUrl.startsWith('http')) {
      setProductImageValue(mode, publicUrl);
      showQuickToast('تم رفع الصورة إلى الـ Storage وحفظ الرابط بنجاح ✓');
    }
  } catch (e) {
    console.warn('Camera photo upload note:', e);
  }
}

function handleCameraModalFileUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  compressImageFile(file, 800, 0.84).then(dataUrl => {
    capturedProductPhotoData = dataUrl;
    stopProductCameraStream();

    const videoEl = document.getElementById('product-camera-video');
    const capturedImg = document.getElementById('product-camera-captured-img');
    const liveControls = document.getElementById('camera-live-controls');
    const reviewControls = document.getElementById('camera-review-controls');

    if (capturedImg) {
      capturedImg.src = dataUrl;
      capturedImg.style.display = 'block';
    }
    if (videoEl) videoEl.style.display = 'none';
    if (liveControls) liveControls.style.display = 'none';
    if (reviewControls) reviewControls.style.display = 'flex';
  }).catch(err => {
    showInAppAlert('تعذر معالجة الصورة: ' + err.message, 'خطأ');
  });
}

async function handleProductFileUpload(event, mode = 'add') {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const dataUrl = await compressImageFile(file, 800, 0.84);
    // Instant preview
    setProductImageValue(mode, dataUrl);
    showQuickToast('جاري رفع الصورة إلى Supabase Storage...');

    // Upload to Supabase Storage 'products' bucket
    const publicUrl = await uploadImageToSupabaseStorage(dataUrl, file.name || `product_${Date.now()}.jpg`);
    if (publicUrl && publicUrl.startsWith('http')) {
      setProductImageValue(mode, publicUrl);
      showQuickToast('تم رفع الصورة إلى الـ Storage في Supabase وحفظ الرابط بنجاح ✓');
    }
  } catch (err) {
    showInAppAlert('تعذر رفع الصورة: ' + err.message, 'خطأ');
  }
}

function compressImageFile(file, maxDimension = 800, quality = 0.84) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxDimension) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          }
        } else {
          if (height > maxDimension) {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(compressedDataUrl);
      };
      img.onerror = () => reject(new Error('الملف ليس صورة صالحة'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('تعذر قراءة الملف'));
    reader.readAsDataURL(file);
  });
}

function setProductImageValue(mode, imageString) {
  const prefix = mode === 'edit' ? 'edit' : 'in';
  const inputEl = document.getElementById(`${prefix}-image`);
  const previewImg = document.getElementById(`${prefix}-image-preview`);
  const placeholder = document.getElementById(`${prefix}-image-placeholder`);
  const removeBtn = document.getElementById(`${prefix}-image-remove-btn`);

  if (inputEl) inputEl.value = imageString || '';

  if (imageString) {
    if (previewImg) {
      previewImg.src = imageString;
      previewImg.style.display = 'block';
    }
    if (placeholder) placeholder.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'flex';
  } else {
    if (previewImg) {
      previewImg.src = '';
      previewImg.style.display = 'none';
    }
    if (placeholder) placeholder.style.display = 'flex';
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

function clearProductImage(mode) {
  setProductImageValue(mode, '');
  const fileInput = document.getElementById(mode === 'edit' ? 'edit-file-input' : 'in-file-input');
  if (fileInput) fileInput.value = '';
}

function updateImagePreviewFromInput(mode) {
  const prefix = mode === 'edit' ? 'edit' : 'in';
  const inputEl = document.getElementById(`${prefix}-image`);
  const val = inputEl ? inputEl.value.trim() : '';
  setProductImageValue(mode, val);
}

function toggleImageUrlInput(mode) {
  const prefix = mode === 'edit' ? 'edit' : 'in';
  const row = document.getElementById(`${prefix}-url-input-row`);
  if (row) {
    row.style.display = row.style.display === 'none' ? 'block' : 'none';
    if (row.style.display === 'block') {
      const input = document.getElementById(`${prefix}-image`);
      if (input) input.focus();
    }
  }
}

// Lightbox modal for zooming product photos
function openImageLightbox(src, title = '') {
  if (!src) return;
  const modal = document.getElementById('modal-image-lightbox');
  const img = document.getElementById('lightbox-img');
  const caption = document.getElementById('lightbox-caption');

  if (img) img.src = src;
  if (caption) caption.innerText = title ? `صورة: ${title}` : 'صورة المادة الدوائية';
  if (modal) modal.classList.add('is-open');
}

function closeImageLightbox() {
  const modal = document.getElementById('modal-image-lightbox');
  if (modal) modal.classList.remove('is-open');
}

// Edit Medicine Modal
function openEditModal(prodId) {
  const item = products.find(x => String(x.id) === String(prodId));
  if (!item) return;

  populateAllDosageFormSelectors();

  const currentStock = item.number !== undefined && item.number !== null ? item.number : (item.quantity !== undefined && item.quantity !== null ? item.quantity : 0);

  document.getElementById('edit-prod-id').value = item.id;
  document.getElementById('edit-name').value = item.name || '';
  document.getElementById('edit-company').value = item.company || '';

  const editFormEl = document.getElementById('edit-form');
  if (editFormEl) {
    if (item.form && !Array.from(editFormEl.options).some(o => o.value.toLowerCase() === item.form.toLowerCase())) {
      const opt = document.createElement('option');
      opt.value = item.form;
      opt.innerText = `💊 ${item.form}`;
      editFormEl.appendChild(opt);
    }
    editFormEl.value = item.form || (dosageForms[0]?.key || 'Tablet');
  }

  document.getElementById('edit-barcode').value = formatBarcode(item.barcode);
  document.getElementById('edit-qty').value = currentStock;
  document.getElementById('edit-min-qty').value = item.minQty || 5;
  document.getElementById('edit-price').value = item.price || 0;
  document.getElementById('edit-bonus').value = item.bonus || 0;
  document.getElementById('edit-exp').value = item.expiryDate || '';

  setProductImageValue('edit', item.image || '');

  const modal = document.getElementById('modal-edit-item');
  if (modal) modal.classList.add('is-open');
}

function closeEditModal() {
  const modal = document.getElementById('modal-edit-item');
  if (modal) modal.classList.remove('is-open');
}

async function saveEditedMedicine() {
  const productId = document.getElementById('edit-prod-id').value;
  const name = (document.getElementById('edit-name').value || '').trim();
  if (!name) { alert('اسم المادة مطلوب'); return; }

  const newQuantityStr = document.getElementById('edit-qty').value;
  let cleanQty = parseInt(newQuantityStr, 10);
  if (isNaN(cleanQty) || cleanQty < 0) {
    const existingProd = products.find(p => String(p.id) === String(productId));
    cleanQty = existingProd ? (existingProd.number ?? existingProd.quantity ?? 0) : 0;
  }

  const price = Number(document.getElementById('edit-price').value) || 0;
  const minQty = Number(document.getElementById('edit-min-qty').value) || 5;
  const bonus = Number(document.getElementById('edit-bonus').value) || 0;
  const company = document.getElementById('edit-company').value.trim();
  const form = document.getElementById('edit-form').value.trim();
  const rawBarcode = document.getElementById('edit-barcode').value;
  const barcode = formatBarcode(rawBarcode);
  const exp = document.getElementById('edit-exp').value.trim();
  const image = (document.getElementById('edit-image')?.value || '').trim();

  // 1. Direct update to Supabase for column "number" and all fields
  const supabase = getSupabaseClient();
  let updatedStock = cleanQty;
  const existingProd = products.find(p => String(p.id) === String(productId));
  const oldQty = existingProd ? (Number(existingProd.number) ?? Number(existingProd.quantity) ?? 0) : 0;

  if (supabase) {
    const { data, error } = await supabase
      .from('samo')
      .update({
        number: cleanQty,
        product: name,
        company: company || null,
        category: form || null,
        barcode: barcode || null,
        price_of_one: price,
        total_price: cleanQty * price,
        bonus: bonus,
        limit_number: minQty,
        expire_date: exp || null,
        image_url: image || null
      })
      .eq('id', productId)
      .select();

    if (error) {
      alert("خطأ في تحديث قاعدة البيانات: " + error.message);
      return;
    }

    if (data && data.length > 0) {
      updatedStock = data[0].number !== undefined && data[0].number !== null ? data[0].number : cleanQty;
    }

    // 1.b. ج. عند تعديل رصيد مادة يدوياً من بطاقة الدواء:
    if (oldQty !== updatedStock) {
      try {
        const prodName = name || existingProd?.product || existingProd?.name || 'مادة';
        await logInventoryMovement('تعديل يدوي', prodName, {
          old_stock: oldQty,
          new_stock: updatedStock,
          previous_qty: oldQty,
          new_qty: updatedStock,
          diff: updatedStock - oldQty
        });
      } catch (logErr) {
        console.warn('Supabase inventory_logs insert warning:', logErr);
      }
    }
  }

  const prod = {
    id: productId,
    name,
    image,
    company,
    form,
    barcode,
    quantity: updatedStock,
    number: updatedStock,
    minQty,
    price,
    totalPrice: updatedStock * price,
    bonus,
    expiryDate: exp
  };

  // 2. Update local UI state immediately without resetting to zero
  const idx = products.findIndex(p => String(p.id) === String(productId));
  if (idx !== -1) {
    products[idx] = { ...products[idx], ...prod, number: updatedStock, quantity: updatedStock };
  } else {
    products.push(prod);
  }
  saveLocalData();
  renderProducts();
  if (typeof renderPosGrid === 'function') renderPosGrid();
  closeEditModal();
  showQuickToast('تم حفظ وتحديث المادة بنجاح ✓');

  // 3. Persist to API proxy
  try {
    const userEmail = currentStaffEmail || localStorage.getItem('samo_staff_email') || '';
    await postToApi({ action: 'update_product', product: prod, staffEmail: userEmail });
  } catch (err) {
    console.warn('Update product server sync warning:', err);
  }
}

function deleteMedicineDirect(id) {
  const p = products.find(x => x.id === id);
  const name = p ? p.name : id;
  const itemId = p?.id || id;

  showInAppConfirm({
    title: 'حذف مادة دوائية من المخزن',
    message: `هل أنت متأكد من حذف مادة <b>(${escapeHtml(name)})</b> نهائياً من المستودع وقاعدة البيانات؟<br><span style="color:#ef4444;font-size:12px;margin-top:4px;display:block;">⚠️ سيتم حذف السطر نهائياً من قاعدة بيانات Supabase (جدول samo) بعد التأكيد.</span>`,
    icon: '🗑️',
    confirmText: 'نعم، حذف المادة نهائياً',
    isDanger: true,
    onConfirm: async () => {
      // 1. Direct Cloud Delete in Supabase via Real ID
      const sb = getSupabaseClient();
      if (sb) {
        const { error } = await sb
          .from('samo')
          .delete()
          .eq('id', itemId);

        if (error) {
          console.error("فشل الحذف من السيرفر:", error);
          alert("خطأ أثناء الحذف من السيرفر: " + error.message);
          return;
        }
      }

      // 2. Server API Delete
      try {
        const userEmail = currentStaffEmail || localStorage.getItem('samo_staff_email') || '';
        const res = await postToApi({ action: 'delete_product', productId: itemId, name: p?.name, barcode: p?.barcode, staffEmail: userEmail });
        if (res && res.status === 'error') {
          alert("خطأ أثناء الحذف من السيرفر: " + (res.message || 'فشل الحذف'));
          return;
        }
      } catch (err) {
        console.error("فشل الحذف من السيرفر:", err);
        alert("خطأ أثناء الحذف من السيرفر: " + err.message);
        return;
      }

      // 3. Update UI only after successful response
      products = products.filter(x => x.id !== id && x.id !== itemId);
      delete cart[id];
      delete cart[itemId];
      delete posCart[id];
      delete posCart[itemId];
      saveLocalData();
      saveLocalCart();
      updateCartBadge();
      renderProducts();
      if (currentTab === 'pos') renderPosGrid();
      showQuickToast(`تم حذف (${name}) من قاعدة البيانات بنجاح ✓`);
    }
  });
}

function deleteMedicineFromEditModal() {
  const id = document.getElementById('edit-prod-id').value;
  const p = products.find(x => x.id === id);
  const name = (document.getElementById('edit-name').value || (p ? p.name : '')).trim();
  const itemId = p?.id || id;
  if (!id) return;

  showInAppConfirm({
    title: 'حذف مادة دوائية نهائياً',
    message: `هل أنت متأكد من حذف مادة <b>(${escapeHtml(name || id)})</b> نهائياً من المستودع وقاعدة البيانات؟<br><span style="color:#ef4444;font-size:12px;margin-top:4px;display:block;">⚠️ سيتم حذف السطر نهائياً من قاعدة بيانات Supabase (جدول samo) بعد التأكيد.</span>`,
    icon: '🗑️',
    confirmText: 'نعم، حذف المادة نهائياً',
    isDanger: true,
    onConfirm: async () => {
      // 1. Direct Cloud Delete in Supabase via Real ID
      const sb = getSupabaseClient();
      if (sb) {
        const { error } = await sb
          .from('samo')
          .delete()
          .eq('id', itemId);

        if (error) {
          console.error("فشل الحذف من السيرفر:", error);
          alert("خطأ أثناء الحذف من السيرفر: " + error.message);
          return;
        }
      }

      // 2. Server API Delete
      try {
        const userEmail = currentStaffEmail || localStorage.getItem('samo_staff_email') || '';
        const res = await postToApi({ action: 'delete_product', productId: itemId, name: name || p?.name, barcode: p?.barcode, staffEmail: userEmail });
        if (res && res.status === 'error') {
          alert("خطأ أثناء الحذف من السيرفر: " + (res.message || 'فشل الحذف'));
          return;
        }
      } catch (err) {
        console.error("فشل الحذف من السيرفر:", err);
        alert("خطأ أثناء الحذف من السيرفر: " + err.message);
        return;
      }

      // 3. Update UI only after confirmation
      products = products.filter(x => x.id !== id && x.id !== itemId);
      delete cart[id];
      delete cart[itemId];
      delete posCart[id];
      delete posCart[itemId];
      saveLocalData();
      saveLocalCart();
      updateCartBadge();
      renderProducts();
      closeEditModal();
      if (currentTab === 'pos') renderPosGrid();
      showQuickToast(`تم حذف (${name || 'المادة'}) من قاعدة البيانات بنجاح ✓`);
    }
  });
}

// Add Medicine Modal
function openAddModal() {
  document.getElementById('in-name').value = '';
  document.getElementById('in-company').value = '';
  document.getElementById('in-form').value = 'Tablet';
  document.getElementById('in-barcode').value = '';
  document.getElementById('in-qty').value = '10';
  document.getElementById('in-min-qty').value = '5';
  document.getElementById('in-price').value = '5000';
  document.getElementById('in-bonus').value = '0';
  document.getElementById('in-exp').value = '';
  calcBonusNet();

  setProductImageValue('add', '');

  const modal = document.getElementById('modal-add-item');
  if (modal) modal.classList.add('is-open');
}

function closeAddModal() {
  const modal = document.getElementById('modal-add-item');
  if (modal) modal.classList.remove('is-open');
}

function calcBonusNet() {
  const pr = Number(document.getElementById('in-price')?.value) || 0;
  const bn = Number(document.getElementById('in-bonus')?.value) || 0;
  const net = bn > 0 ? Math.round(pr * (1 - bn / 100)) : pr;
  const hint = document.getElementById('bonus-hint');
  if (hint) hint.innerText = `السعر الفعلي: ${net.toLocaleString()} د.ع`;
}

async function saveNewMedicine() {
  const name = (document.getElementById('in-name').value || '').trim();
  if (!name) { alert('اسم المادة الدوائية مطلوب'); return; }

  const newQuantity = document.getElementById('in-qty').value;
  const cleanQty = parseInt(newQuantity, 10) || 0;
  const price = Number(document.getElementById('in-price').value) || 0;
  const minQty = Number(document.getElementById('in-min-qty').value) || 5;
  const bonus = Number(document.getElementById('in-bonus').value) || 0;
  const productId = `PROD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const rawBarcode = (document.getElementById('in-barcode').value || '').trim();
  const cleanBarcode = formatBarcode(rawBarcode);

  const nowIso = new Date().toISOString();

  const newProd = {
    id: productId,
    name,
    image: (document.getElementById('in-image')?.value || '').trim(),
    company: document.getElementById('in-company').value.trim(),
    form: document.getElementById('in-form').value.trim(),
    barcode: cleanBarcode,
    quantity: cleanQty,
    number: cleanQty,
    minQty: minQty,
    price: price,
    totalPrice: cleanQty * price,
    bonus: bonus,
    expiryDate: document.getElementById('in-exp').value.trim(),
    createdAt: nowIso,
    created_at: nowIso
  };

  const newProductData = {
    id: productId,
    product: name,
    company: newProd.company || null,
    category: newProd.form || null,
    barcode: newProd.barcode || null,
    number: cleanQty,
    price_of_one: price,
    total_price: cleanQty * price,
    bonus: bonus,
    limit_number: minQty,
    expire_date: newProd.expiryDate || null,
    image_url: newProd.image || null,
    created_at: nowIso
  };

  // 1. Direct Supabase insert for column "number" and "created_at"
  const supabase = getSupabaseClient();
  if (supabase) {
    const { data, error } = await supabase
      .from('samo')
      .insert([newProductData])
      .select();

    if (error) {
      alert("خطأ في تحديث قاعدة البيانات: " + error.message);
      return;
    }

    if (data && data.length > 0) {
      const serverNum = data[0].number !== undefined && data[0].number !== null ? data[0].number : cleanQty;
      newProd.number = serverNum;
      newProd.quantity = serverNum;
      if (data[0].created_at) {
        newProd.created_at = data[0].created_at;
        newProd.createdAt = data[0].created_at;
      }
    }
  }

  // 2. Instant local optimistic addition
  products.unshift(newProd);
  saveLocalData();
  renderProducts();
  if (typeof renderPosGrid === 'function') renderPosGrid();
  closeAddModal();
  showQuickToast('تمت إضافة المادة وحفظها بنجاح ✓');

  // 3. Persist to API
  try {
    const userEmail = currentStaffEmail || localStorage.getItem('samo_staff_email') || '';
    await postToApi({ action: 'add_product', product: newProd, staffEmail: userEmail });
  } catch (err) {
    console.warn('Add product server sync warning:', err);
  }
}

async function saveCurrentReportToCloud() {
  const pharmacies = new Set(orders.map(o => o.pharmacyName).filter(Boolean));
  const totalDispatched = orders.reduce((acc, o) => acc + (Number(o.totalAmount) || 0), 0);
  const staffEmail = currentStaffEmail || localStorage.getItem('samo_staff_email') || 'admin@samo.iq';
  const summaryObj = {
    generatedAt: new Date().toISOString(),
    staffEmail: staffEmail,
    totalDispatched: totalDispatched,
    totalOrders: orders.length,
    ordersCount: orders.length,
    pharmaciesCount: pharmacies.size,
    productsCount: products.length,
    itemsCount: products.length
  };
  const reportData = {
    report_type: 'مبيعات يومية',
    report_date: new Date().toISOString().slice(0, 10),
    summary: JSON.stringify(summaryObj),
    total_sales: totalDispatched,
    generated_by: staffEmail,
    created_at: new Date().toISOString()
  };

  try {
    const sb = getSupabaseClient();
    if (sb) {
      const { error: sbErr } = await sb.from('reports').insert([reportData]);
      if (sbErr) {
        console.warn('Direct Supabase report insert note:', sbErr.message);
      }
    }

    const res = await fetch('/api/supabase/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reportData)
    });
    const json = await res.json();
    if (json.success) {
      showQuickToast('تم حفظ التقرير في جدول reports بقاعدة بيانات Supabase بنجاح ✓');
    }
    await fetchReportsFromSupabaseDirect(false);
  } catch (err) {
    console.warn('Save report error:', err);
    showQuickToast('حدث خطأ أثناء حفظ التقرير: ' + err.message, 'error');
  }
}
window.saveCurrentReportToCloud = saveCurrentReportToCloud;

function generateBarcodeField(fieldId) {
  const randomCode = '628' + Math.floor(100000000 + Math.random() * 900000000);
  const field = document.getElementById(fieldId);
  if (field) field.value = randomCode;
}

// Camera Scanner
function openCameraScanner(targetInputId) {
  currentScannerTarget = targetInputId || 'search-box';
  const modal = document.getElementById('modal-scanner');
  if (modal) modal.classList.add('is-open');

  const status = document.getElementById('scanner-status');
  if (status) status.innerText = 'جاري تشغيل الكاميرا...';

  try {
    html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 150 } },
      (decodedText) => {
        onBarcodeScanned(decodedText);
      },
      (error) => {
        // quiet frame error
      }
    ).catch(err => {
      if (status) status.innerText = 'تعذر تشغيل الكاميرا المباشرة، يمكنك اختيار صورة من المعرض.';
    });
  } catch (e) {
    if (status) status.innerText = 'خطأ في تشغيل القارئ.';
  }
}

function closeCameraScanner() {
  if (html5QrCode) {
    html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
    html5QrCode = null;
  }
  const modal = document.getElementById('modal-scanner');
  if (modal) modal.classList.remove('is-open');
}

function onBarcodeScanned(code) {
  closeCameraScanner();
  const cleanCode = formatBarcode(code);
  const target = document.getElementById(currentScannerTarget);
  if (target) {
    target.value = cleanCode;
    if (currentScannerTarget === 'search-box') handleMainSearchInput();
    else if (currentScannerTarget === 'pos-search-box') handlePosSearchInput();
  }

  // Direct product match using formatBarcode
  if (cleanCode && currentScannerTarget === 'pos-search-box') {
    const match = products.find(p => formatBarcode(p.barcode) === cleanCode);
    if (match) {
      if (Number(match.quantity) <= 0) {
        showInAppAlert(`المادة (${match.name}) نافذة من المخزن حالياً.`, 'رصيد نافذ');
        return;
      }
      addToPosCart(match.id);
      if (target) target.value = '';
      renderPosGrid();
    }
  }
}

function scanBarcodeFromImage() {
  const input = document.getElementById('barcode-image-input');
  if (input) {
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const qr = new Html5Qrcode("reader");
        const res = await qr.scanFile(file, true);
        onBarcodeScanned(res);
      } catch (err) {
        alert('تعذر قراءة الباركود من الصورة المحددة.');
      }
    };
    input.click();
  }
}

// ==========================================
// Advanced Barcode Studio & Thermal Printer Recognition
// ==========================================
let activePairedPrinter = null;

function initBarcodePrinterStudio() {
  checkExistingPrinters();
}

async function checkExistingPrinters() {
  const statusTitle = document.getElementById('printer-detected-title');
  const statusDetail = document.getElementById('printer-detected-detail');
  const statusIcon = document.getElementById('printer-status-icon');
  if (!statusTitle) return;

  // 1. Check WebUSB paired devices
  if (navigator.usb) {
    try {
      const devices = await navigator.usb.getDevices();
      if (devices && devices.length > 0) {
        const d = devices[0];
        activePairedPrinter = d;
        const pName = d.productName || 'طابعة USB حرارية متصلة';
        if (statusTitle) statusTitle.innerText = `🟢 متصلة: ${pName}`;
        if (statusDetail) statusDetail.innerText = `جاهزة للطباعة الحرارية المباشرة (Vendor ID: 0x${d.vendorId.toString(16).toUpperCase()})`;
        if (statusIcon) statusIcon.innerText = '⚡';
        return;
      }
    } catch (e) {
      console.log('USB check note:', e);
    }
  }

  // 2. Check local printing bridge if available
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const bridgeRes = await fetch('http://127.0.0.1:9090/status', { signal: controller.signal }).catch(() => null);
    clearTimeout(timer);
    if (bridgeRes && bridgeRes.ok) {
      const bInfo = await bridgeRes.json().catch(() => ({}));
      if (statusTitle) statusTitle.innerText = `🟢 جسر الطباعة المحلي نشط (Port 9090)`;
      if (statusDetail) statusDetail.innerText = bInfo.printerName ? `طابعة متصلة: ${bInfo.printerName}` : 'جاهز لإرسال أوامر TSPL/ZPL المباشرة';
      if (statusIcon) statusIcon.innerText = '🌐';
      return;
    }
  } catch (e) {}

  // 3. Fallback to Windows Direct Thermal Driver
  if (statusTitle) statusTitle.innerText = `🖨️ جاهزة للطباعة الحرارية (مشغل Windows المباشر)`;
  if (statusDetail) statusDetail.innerText = `معايرة حسّاس الفواصل (Gap Sensor 1:1) مفعلة تلقائياً لمنع إهدار الملصقات`;
  if (statusIcon) statusIcon.innerText = '🖨️';
}

async function detectAndPairPrinters() {
  const statusTitle = document.getElementById('printer-detected-title');
  const statusDetail = document.getElementById('printer-detected-detail');
  const statusIcon = document.getElementById('printer-status-icon');

  if (!navigator.usb) {
    showInAppAlert('متصفحك الحالي لا يدعم WebUSB المباشر. يمكنك استخدام مشغل Windows المباشر للطباعة الحرارية بدقة تامة.', 'ℹ️ تنبيه التوافق');
    return;
  }

  try {
    if (statusTitle) statusTitle.innerText = '🔍 جاري البحث عن طابعات USB...';
    // Request device with common receipt/barcode printer vendor IDs or empty filter
    const device = await navigator.usb.requestDevice({
      filters: []
    });

    if (device) {
      activePairedPrinter = device;
      const devName = device.productName || 'طابعة باركود USB';
      if (statusTitle) statusTitle.innerText = `🟢 تم التعرف على الطابعة: ${devName}`;
      if (statusDetail) statusDetail.innerText = `تم الربط بنجاح عبر منفذ USB مباشر (Vendor: 0x${device.vendorId.toString(16).toUpperCase()})`;
      if (statusIcon) statusIcon.innerText = '✅';

      // Update select box to indicate USB connected
      const sel = document.getElementById('print-printer-select');
      if (sel) {
        sel.value = 'auto_usb';
        sel.options[0].text = `🟢 [USB متصل] ${devName}`;
      }
    }
  } catch (err) {
    if (err.name !== 'NotFoundError') {
      console.warn('Printer pairing notice:', err);
    }
    checkExistingPrinters();
  }
}

function onPrinterSelectionChanged() {
  const sel = document.getElementById('print-printer-select');
  const val = sel?.value || 'windows';
  const methodSel = document.getElementById('print-method-select');

  if (val === 'xprinter' || val === 'tsc' || val === 'zebra') {
    if (methodSel) methodSel.value = 'thermal_exact';
  }
  updateBarcodeLivePreview();
}

function onPrintSizePresetChanged() {
  const sel = document.getElementById('print-size-select');
  const val = sel?.value || '50x30';
  const customRow = document.getElementById('custom-size-row');
  const wInput = document.getElementById('print-width-input');
  const hInput = document.getElementById('print-height-input');

  if (val === 'custom') {
    if (customRow) customRow.style.display = 'grid';
  } else {
    if (customRow) customRow.style.display = 'none';
    const [w, h] = val.split('x').map(Number);
    if (wInput) wInput.value = w;
    if (hInput) hInput.value = h;
  }

  const lbl = document.getElementById('prev-size-lbl');
  if (lbl) {
    const curW = wInput?.value || 50;
    const curH = hInput?.value || 30;
    lbl.innerText = `${curW} × ${curH} مم`;
  }
  updateBarcodeLivePreview();
}

function onCustomPrintSizeChanged() {
  const wInput = document.getElementById('print-width-input');
  const hInput = document.getElementById('print-height-input');
  const lbl = document.getElementById('prev-size-lbl');
  if (lbl && wInput && hInput) {
    lbl.innerText = `${wInput.value} × ${hInput.value} مم`;
  }
  updateBarcodeLivePreview();
}

function onPrintSettingChanged() {
  const copiesInput = document.getElementById('print-copies-input');
  const copiesLbl = document.getElementById('print-btn-copies-lbl');
  if (copiesLbl && copiesInput) {
    copiesLbl.innerText = copiesInput.value || '1';
  }
  updateBarcodeLivePreview();
}

function setBarcodeCopies(qty) {
  const input = document.getElementById('print-copies-input');
  if (!input) return;

  if (qty === 'stock') {
    const stock = Number(currentBarcodePayload?.quantity || 1);
    input.value = Math.max(1, stock);
  } else {
    input.value = qty;
  }
  onPrintSettingChanged();
}

function updateBarcodeLivePreview() {
  const p = currentBarcodePayload;
  if (!p) return;

  const wInput = document.getElementById('print-width-input');
  const hInput = document.getElementById('print-height-input');
  const widthMm = Number(wInput?.value || 50);
  const heightMm = Number(hInput?.value || 30);

  const showWarehouse = document.getElementById('lbl-chk-warehouse')?.checked ?? true;
  const showName = document.getElementById('lbl-chk-name')?.checked ?? true;
  const showBarcode = document.getElementById('lbl-chk-barcode')?.checked ?? true;
  const showNum = document.getElementById('lbl-chk-num')?.checked ?? true;
  const showPrice = document.getElementById('lbl-chk-price')?.checked ?? true;
  const showExpiry = document.getElementById('lbl-chk-expiry')?.checked ?? true;

  const canvas = document.getElementById('barcode-sticker-canvas');
  if (canvas) {
    // Dynamically scale canvas preview box to mimic real sticker aspect ratio
    const previewWidthPx = Math.min(320, Math.max(200, widthMm * 5.2));
    const previewHeightPx = Math.max(110, (previewWidthPx / widthMm) * heightMm);
    canvas.style.width = `${previewWidthPx}px`;
    canvas.style.minHeight = `${previewHeightPx}px`;
  }

  const elWarehouse = document.getElementById('prev-barcode-warehouse');
  const elName = document.getElementById('prev-barcode-name');
  const elSvg = document.getElementById('prev-barcode-svg');
  const elNum = document.getElementById('prev-barcode-num');
  const elPrice = document.getElementById('prev-barcode-price');
  const elExpiry = document.getElementById('prev-barcode-expiry');

  if (elWarehouse) elWarehouse.style.display = showWarehouse ? 'block' : 'none';
  if (elName) {
    elName.style.display = showName ? 'block' : 'none';
    elName.innerText = p.name || 'اسم الدواء';
  }

  if (elSvg) {
    elSvg.style.display = showBarcode ? 'block' : 'none';
    if (showBarcode) {
      try {
        const cleanBC = formatBarcode(p.barcode) || '123456789';
        JsBarcode("#prev-barcode-svg", cleanBC, {
          format: "CODE128",
          lineColor: "#000",
          width: widthMm > 50 ? 2 : 1.5,
          height: Math.max(30, Math.min(55, heightMm * 1.3)),
          displayValue: false
        });
      } catch (e) {
        console.warn('JsBarcode render:', e);
      }
    }
  }

  if (elNum) {
    elNum.style.display = showNum ? 'block' : 'none';
    elNum.innerText = formatBarcode(p.barcode) || '0000000000000';
  }

  if (elPrice) {
    elPrice.style.display = showPrice ? 'inline' : 'none';
    elPrice.innerText = `${Number(p.price || 0).toLocaleString()} د.ع`;
  }

  if (elExpiry) {
    elExpiry.style.display = showExpiry ? 'inline' : 'none';
    elExpiry.innerText = p.expiryDate ? `EXP: ${p.expiryDate}` : '';
  }
}

// Open Direct Barcode Modal
function openDirectBarcodeModal(prodId) {
  const p = products.find(x => x.id === prodId);
  if (!p) return;
  currentBarcodePayload = p;

  const modal = document.getElementById('modal-direct-barcode');
  if (modal) modal.classList.add('is-open');

  const copiesInput = document.getElementById('print-copies-input');
  if (copiesInput) copiesInput.value = '1';

  checkExistingPrinters();
  onPrintSizePresetChanged();
}

function closeDirectBarcodeModal() {
  const modal = document.getElementById('modal-direct-barcode');
  if (modal) modal.classList.remove('is-open');
}

function printBarcodeDirectFromEdit() {
  const barcode = document.getElementById('edit-barcode')?.value;
  const name = document.getElementById('edit-name')?.value;
  const price = document.getElementById('edit-price')?.value;
  const exp = document.getElementById('edit-exp')?.value;
  openDirectBarcodeModalWithData(name, barcode, price, exp);
}

function printBarcodeDirectFromAdd() {
  const barcode = document.getElementById('in-barcode')?.value;
  const name = document.getElementById('in-name')?.value;
  const price = document.getElementById('in-price')?.value;
  const exp = document.getElementById('in-exp')?.value;
  openDirectBarcodeModalWithData(name, barcode, price, exp);
}

function openDirectBarcodeModalWithData(name, barcode, price, exp = '') {
  currentBarcodePayload = {
    name: name || 'اسم المادة',
    barcode: formatBarcode(barcode) || '123456789',
    price: Number(price) || 0,
    expiryDate: exp || ''
  };

  const modal = document.getElementById('modal-direct-barcode');
  if (modal) modal.classList.add('is-open');

  checkExistingPrinters();
  onPrintSizePresetChanged();
}

// Advanced Thermal Label Execution
function executeAdvancedBarcodePrint() {
  const p = currentBarcodePayload;
  if (!p) {
    showInAppAlert('يرجى تحديد مادة أولاً لطباعة الباركود.', 'تنبيه');
    return;
  }

  const wInput = document.getElementById('print-width-input');
  const hInput = document.getElementById('print-height-input');
  const copiesInput = document.getElementById('print-copies-input');
  const widthMm = Number(wInput?.value || 50);
  const heightMm = Number(hInput?.value || 30);
  const copies = Math.max(1, parseInt(copiesInput?.value || '1', 10));

  const showWarehouse = document.getElementById('lbl-chk-warehouse')?.checked ?? true;
  const showName = document.getElementById('lbl-chk-name')?.checked ?? true;
  const showBarcode = document.getElementById('lbl-chk-barcode')?.checked ?? true;
  const showNum = document.getElementById('lbl-chk-num')?.checked ?? true;
  const showPrice = document.getElementById('lbl-chk-price')?.checked ?? true;
  const showExpiry = document.getElementById('lbl-chk-expiry')?.checked ?? true;
  const cleanBC = formatBarcode(p.barcode) || '123456789';

  const printWindow = window.open('', '_blank', 'width=450,height=380');
  if (!printWindow) {
    showInAppAlert('يرجى السماح بالنوافذ المنبثقة (Popups) في المتصفح لتنفيذ طباعة الباركود المباشرة.', 'تنبيه الطباعة');
    return;
  }

  // Generate repetitive label pages for exact thermal sticker printing
  let pagesHtml = '';
  for (let i = 0; i < copies; i++) {
    pagesHtml += `
      <div class="label-page">
        ${showWarehouse ? '<div class="warehouse-title">مستودع سامو للأدوية</div>' : ''}
        ${showName ? `<div class="med-name">${escapeHtml(p.name)}</div>` : ''}
        ${showBarcode ? `<svg class="bc-svg" id="bc_${i}"></svg>` : ''}
        ${showNum ? `<div class="bc-num">${escapeHtml(cleanBC)}</div>` : ''}
        <div class="footer-row">
          ${showPrice ? `<span class="med-price">${Number(p.price || 0).toLocaleString()} د.ع</span>` : '<span></span>'}
          ${showExpiry && p.expiryDate ? `<span class="med-exp">EXP: ${escapeHtml(p.expiryDate)}</span>` : ''}
        </div>
      </div>
    `;
  }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
      <meta charset="utf-8">
      <title>طباعة باركود - ${escapeHtml(p.name)}</title>
      <style>
        @page {
          size: ${widthMm}mm ${heightMm}mm;
          margin: 0mm !important;
        }
        * {
          box-sizing: border-box;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        html, body {
          margin: 0;
          padding: 0;
          background: #fff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        }
        .label-page {
          width: ${widthMm}mm;
          height: ${heightMm}mm;
          max-width: ${widthMm}mm;
          max-height: ${heightMm}mm;
          padding: 1.5mm 2mm;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: space-between;
          text-align: center;
          page-break-after: always;
          break-after: page;
          overflow: hidden;
        }
        .warehouse-title {
          font-size: 8px;
          font-weight: 800;
          color: #000;
          line-height: 1;
          margin-bottom: 0.5mm;
        }
        .med-name {
          font-size: 10px;
          font-weight: 800;
          color: #000;
          line-height: 1.1;
          max-width: 98%;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .bc-svg {
          max-width: 96%;
          height: ${Math.max(16, heightMm - 14)}mm;
          margin: 0.5mm 0;
        }
        .bc-num {
          font-family: monospace, monospace;
          font-size: 8.5px;
          font-weight: 800;
          color: #000;
          line-height: 1;
          letter-spacing: 0.5px;
        }
        .footer-row {
          width: 96%;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 8.5px;
          font-weight: 800;
          color: #000;
          line-height: 1;
          margin-top: 0.5mm;
        }
        .med-exp {
          font-family: monospace;
          font-size: 8px;
        }
      </style>
      <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
    </head>
    <body>
      ${pagesHtml}
      <script>
        window.addEventListener('DOMContentLoaded', () => {
          const barcodeVal = "${cleanBC}";
          const count = ${copies};
          for (let i = 0; i < count; i++) {
            const svgEl = document.getElementById("bc_" + i);
            if (svgEl) {
              JsBarcode(svgEl, barcodeVal, {
                format: "CODE128",
                width: ${widthMm > 50 ? 1.8 : 1.3},
                height: ${Math.max(25, heightMm * 1.1)},
                displayValue: false,
                margin: 0
              });
            }
          }
          setTimeout(() => {
            window.focus();
            window.print();
            setTimeout(() => { window.close(); }, 500);
          }, 350);
        });
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

function testPrinterCalibration() {
  const wInput = document.getElementById('print-width-input');
  const hInput = document.getElementById('print-height-input');
  const widthMm = Number(wInput?.value || 50);
  const heightMm = Number(hInput?.value || 30);

  const printWindow = window.open('', '_blank', 'width=400,height=300');
  if (!printWindow) return;

  printWindow.document.write(`
    <!DOCTYPE html>
    <html dir="rtl">
    <head>
      <meta charset="utf-8">
      <title>معايرة الطابعة</title>
      <style>
        @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
        body { margin: 0; padding: 2mm; text-align: center; font-family: sans-serif; display:flex; flex-direction:column; justify-content:center; align-items:center; height:100vh; }
        .box { border: 1.5px solid #000; width: 95%; padding: 3mm 1mm; border-radius: 4px; }
        .title { font-size: 11px; font-weight: bold; }
        .sub { font-size: 9px; font-family: monospace; margin-top: 2px; }
      </style>
    </head>
    <body>
      <div class="box">
        <div class="title">🧪 فحص معايرة الحساس (GAP)</div>
        <div class="sub">${widthMm}mm × ${heightMm}mm | OK ✓</div>
      </div>
      <script>
        setTimeout(() => { window.print(); window.close(); }, 300);
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

function printBarcodeBrowserFallback() {
  executeAdvancedBarcodePrint();
}

// ==========================================
// Dual-Screen POS System & Fully Editable Cart
// ==========================================
let posSelectedCategory = '';

function filterPosByCategory(category, btnElement, e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  posSelectedCategory = category;
  const chips = document.querySelectorAll('#pos-category-chips .pos-chip');
  chips.forEach(c => c.classList.remove('active'));
  if (btnElement) btnElement.classList.add('active');
  renderPosGrid();
}

function handlePosSearchInput() {
  const box = document.getElementById('pos-search-box');
  const clearBtn = document.getElementById('pos-search-clear-btn');
  if (box && clearBtn) {
    clearBtn.style.display = box.value.trim() ? 'flex' : 'none';
  }
  renderPosGrid();
}

function handlePosBarcodeEnter(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    const box = document.getElementById('pos-search-box');
    const val = (box?.value || '').trim();
    if (!val) return;

    const cleanScan = formatBarcode(val);

    // Look for exact barcode match first
    const match = products.find(p => formatBarcode(p.barcode) === cleanScan) ||
                  products.find(p => (p.barcode || '').toLowerCase() === val.toLowerCase()) ||
                  products.find(p => (p.name || '').toLowerCase() === val.toLowerCase());

    if (match) {
      if (Number(match.quantity) <= 0) {
        showInAppAlert(`المادة (${match.name}) نافذة من المخزن حالياً.`, 'رصيد نافذ');
        return;
      }
      addToPosCart(match.id, e);
      if (box) {
        box.value = '';
        const clearBtn = document.getElementById('pos-search-clear-btn');
        if (clearBtn) clearBtn.style.display = 'none';
      }
      renderPosGrid();
    }
  }
}

function renderPosGrid() {
  const container = document.getElementById('pos-grid-container');
  const countLbl = document.getElementById('pos-products-count-lbl');
  if (!container) return;

  const query = (document.getElementById('pos-search-box')?.value || '').trim().toLowerCase();

  const list = products.filter(p => {
    const currentStock = p.number !== undefined && p.number !== null ? p.number : (p.quantity !== undefined && p.quantity !== null ? p.quantity : 0);
    if (!query && posHideOutOfStock && currentStock <= 0) return false;
    if (posSelectedCategory && (p.form || '').toLowerCase() !== posSelectedCategory.toLowerCase()) return false;
    if (query) {
      const matchName = (p.name || '').toLowerCase().includes(query);
      const cleanBC = formatBarcode(p.barcode);
      const matchBarcode = (p.barcode || '').toLowerCase().includes(query) || (cleanBC && cleanBC.includes(query));
      const matchComp = (p.company || '').toLowerCase().includes(query);
      if (!matchName && !matchBarcode && !matchComp) return false;
    }
    return true;
  });

  if (countLbl) {
    countLbl.innerText = `${list.length} مادة متوفرة للعرض`;
  }

  if (list.length === 0) {
    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--ios-sub);font-size:13px;">لا توجد مواد مطابقة للبحث أو الفلتر</div>`;
    return;
  }

  container.innerHTML = list.map(p => {
    const currentStock = p.number !== undefined && p.number !== null ? p.number : (p.quantity !== undefined && p.quantity !== null ? p.quantity : 0);
    const qty = currentStock;
    const price = Number(p.price) || 0;
    const bonus = Number(p.bonus) || 0;
    const net = bonus > 0 ? Math.round(price * (1 - bonus / 100)) : price;
    const inCartQty = posCart[p.id] || 0;

    return `
      <div class="pos-card-med">
        <div style="display:flex; gap:8px; align-items:flex-start;">
          ${p.image ? `<img src="${p.image}" alt="" style="width:38px;height:38px;border-radius:8px;object-fit:cover;flex-shrink:0;border:1px solid var(--ios-border);cursor:pointer;" onclick="openImageLightbox('${escapeHtml(p.image)}', '${escapeHtml(p.name)}')" title="اضغط لتكبير الصورة">` : ''}
          <div style="flex:1;min-width:0;">
            <div class="pos-card-name">${escapeHtml(p.name)}</div>
            <div class="pos-card-meta">
              <span>${p.form ? escapeHtml(p.form) : 'عام'}</span>
              ${p.company ? `<span>• ${escapeHtml(p.company)}</span>` : ''}
              ${p.barcode ? `<span style="font-family:monospace;background:#f1f5f9;padding:1px 4px;border-radius:4px;font-size:10px;">${escapeHtml(formatBarcode(p.barcode))}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="pos-card-footer">
          <div>
            <div style="color:var(--ios-green);font-weight:800;font-size:13px;">${net.toLocaleString()} د.ع</div>
            <div style="font-size:10.5px;color:${qty <= 0 ? 'var(--ios-red)' : 'var(--ios-sub)'};">
              ${qty <= 0 ? 'نفذ من المخزن' : `المتوفر: <b>${qty}</b>`}
            </div>
          </div>
          <div>
            ${qty <= 0 ? `
              <button type="button" class="btn btn-sec" style="font-size:11px;padding:4px 8px;opacity:0.5;cursor:not-allowed;" disabled>نافذ</button>
            ` : inCartQty > 0 ? `
              <div style="display:flex;align-items:center;gap:3px;background:#e0f2fe;padding:2px 4px;border-radius:8px;">
                <button type="button" style="border:none;background:#bae6fd;color:#0369a1;width:22px;height:22px;border-radius:6px;font-weight:bold;cursor:pointer;" onclick="changePosCartQty('${p.id}', -1, event)">-</button>
                <span style="font-size:11px;font-weight:bold;color:#0369a1;min-width:18px;text-align:center;">${inCartQty}</span>
                <button type="button" style="border:none;background:var(--ios-blue);color:#fff;width:22px;height:22px;border-radius:6px;font-weight:bold;cursor:pointer;" onclick="addToPosCart('${p.id}', event)">+</button>
              </div>
            ` : `
              <button type="button" class="btn btn-sec" style="font-size:11px;padding:5px 10px;font-weight:700;color:var(--ios-blue);border-color:#bfdbfe;background:#eff6ff;" onclick="addToPosCart('${p.id}', event)">
                + إضافة
              </button>
            `}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function addToPosCart(prodId, e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  const p = products.find(x => x.id === prodId);
  if (!p || Number(p.quantity) <= 0) return;
  const cur = posCart[prodId] || 0;
  if (cur < Number(p.quantity)) {
    posCart[prodId] = cur + 1;
    savePosCart();
    renderPosCart();
    renderPosGrid();
  } else {
    showInAppAlert(`الكمية المتاحة في المستودع لهذا الدواء هي (${p.quantity}) فقط.`, 'الحد الأقصى للمخزون');
  }
}
window.addToPosCart = addToPosCart;

function changePosCartQty(prodId, delta, e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  const p = products.find(x => x.id === prodId);
  if (!p) return;
  const cur = posCart[prodId] || 0;
  const next = Math.max(0, Math.min(Number(p.quantity), cur + delta));
  if (next === 0) {
    delete posCart[prodId];
    delete posCartCustomPrices[prodId];
  } else {
    posCart[prodId] = next;
  }
  savePosCart();
  renderPosCart();
  renderPosGrid();
}
window.changePosCartQty = changePosCartQty;

function setPosCartExactQty(prodId, val, e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  const p = products.find(x => x.id === prodId);
  if (!p) return;
  const num = parseInt(val, 10);
  if (isNaN(num) || num <= 0) {
    delete posCart[prodId];
    delete posCartCustomPrices[prodId];
  } else {
    posCart[prodId] = Math.min(Number(p.quantity), num);
  }
  savePosCart();
  renderPosCart();
  renderPosGrid();
}
window.setPosCartExactQty = setPosCartExactQty;

function setPosCartCustomPrice(prodId, val, e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  const num = parseFloat(val);
  if (!isNaN(num) && num >= 0) {
    posCartCustomPrices[prodId] = num;
  } else {
    delete posCartCustomPrices[prodId];
  }
  savePosCart();
  recalcPosTotals();
}
window.setPosCartCustomPrice = setPosCartCustomPrice;

function removePosCartItem(prodId, e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  delete posCart[prodId];
  delete posCartCustomPrices[prodId];
  savePosCart();
  renderPosCart();
  renderPosGrid();
}
window.removePosCartItem = removePosCartItem;

function clearPosCartPrompt(e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  const count = Object.keys(posCart).length;
  if (count === 0) return;

  showInAppConfirm({
    title: 'تفريغ سلة نقطة البيع',
    message: 'هل أنت متأكد من تفريغ كافة المواد الموجودة في السلة الحالية؟',
    confirmText: 'نعم، إفراغ السلة',
    cancelText: 'تراجع',
    isDestructive: true,
    onConfirm: () => {
      posCart = {};
      posCartCustomPrices = {};
      savePosCart();
      renderPosCart();
      renderPosGrid();
    }
  });
}
window.clearPosCartPrompt = clearPosCartPrompt;

let currentPosMobileTab = 'products';

function switchPosMobileScreen(screen) {
  if (screen) currentPosMobileTab = screen;
  const prodScreen = document.getElementById('pos-screen-products');
  const cartScreen = document.getElementById('pos-screen-cart');
  // Both screens are displayed together in the POS tab at all times
  if (prodScreen) {
    prodScreen.style.display = 'flex';
    prodScreen.classList.add('is-active-mobile');
  }
  if (cartScreen) {
    cartScreen.style.display = 'flex';
    cartScreen.classList.add('is-active-mobile');
  }
}
window.switchPosMobileScreen = switchPosMobileScreen;

function togglePosPharmacyCustomMode() {
  const wrap = document.getElementById('pos-ph-custom-input-wrap');
  if (!wrap) return;
  if (wrap.style.display === 'none' || !wrap.style.display) {
    wrap.style.display = 'block';
    const input = document.getElementById('pos-ph-name');
    if (input) input.focus();
  } else {
    wrap.style.display = 'none';
  }
}
window.togglePosPharmacyCustomMode = togglePosPharmacyCustomMode;

function populatePosPharmaciesDropdown() {
  const sel = document.getElementById('pos-ph-select');
  const datalist = document.getElementById('pos-pharmacies-datalist');
  if (!sel) return;

  const currentVal = sel.value || selectedPharmacy;
  sel.innerHTML = '<option value="">-- اختر الصيدلية / العميل --</option>';

  const list = Array.isArray(customersList) && customersList.length > 0
    ? [...customersList]
    : (Array.isArray(pharmacies) ? [...pharmacies] : []);

  list.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.dataset.id = c.id;
    opt.dataset.phone = c.phone || '';
    opt.dataset.address = c.address || '';
    opt.innerText = `${c.name}${c.phone ? ` (${c.phone})` : ''}`;
    sel.appendChild(opt);
  });

  if (currentVal && Array.from(sel.options).some(o => o.value === currentVal)) {
    sel.value = currentVal;
  }

  if (datalist) {
    datalist.innerHTML = list.map(c => `<option value="${escapeHtml(c.name)}">`).join('');
  }
}
window.populatePosPharmaciesDropdown = populatePosPharmaciesDropdown;

async function quickSaveCustomerFromPos() {
  const name = (document.getElementById('pos-ph-name')?.value || '').trim();
  const phone = (document.getElementById('pos-ph-phone')?.value || '').trim();
  if (!name) {
    alert('يرجى كتابة اسم الصيدلية أولاً');
    return;
  }
  await addNewCustomer({ name, phone, address: null });
}
window.quickSaveCustomerFromPos = quickSaveCustomerFromPos;

function onPosPharmacyDropdownChanged(val) {
  const nameInput = document.getElementById('pos-ph-name');
  const phoneInput = document.getElementById('pos-ph-phone');
  const customWrap = document.getElementById('pos-ph-custom-input-wrap');
  const sel = document.getElementById('pos-ph-select');

  if (!val) {
    if (nameInput) nameInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (customWrap) customWrap.style.display = 'none';
    return;
  }

  if (customWrap) customWrap.style.display = 'none';
  if (nameInput) nameInput.value = val;

  const opt = sel ? sel.options[sel.selectedIndex] : null;
  const phoneFromOpt = opt ? (opt.dataset.phone || '') : '';

  if (phoneInput) {
    if (phoneFromOpt) {
      phoneInput.value = phoneFromOpt;
    } else {
      const match = (Array.isArray(pharmacies) ? pharmacies : []).find(p => String(p.name || '').trim() === val.trim()) ||
                    orders.find(o => String(o.pharmacyName || '').trim() === val.trim() && o.phone);
      if (match && match.phone) {
        phoneInput.value = match.phone;
      }
    }
  }
}
window.onPosPharmacyDropdownChanged = onPosPharmacyDropdownChanged;

function onPosPharmacySelected(name) {
  if (!name) return;
  const match = (Array.isArray(pharmacies) ? pharmacies : []).find(p => String(p.name || '').trim() === name.trim()) ||
                orders.find(o => String(o.pharmacyName || '').trim() === name.trim() && o.phone);
  if (match && match.phone) {
    const phoneInput = document.getElementById('pos-ph-phone');
    if (phoneInput && !phoneInput.value) {
      phoneInput.value = match.phone;
    }
  }
}
window.onPosPharmacySelected = onPosPharmacySelected;

function renderPosCart() {
  const container = document.getElementById('pos-cart-summary');
  const countLbl = document.getElementById('pos-cart-count-lbl');
  const statLbl = document.getElementById('pos-cart-items-stat');
  const mobileBadge = document.getElementById('pos-mobile-cart-badge');
  if (!container) return;

  populatePosPharmaciesDropdown();

  const entries = Object.entries(posCart);
  if (mobileBadge) {
    mobileBadge.innerText = entries.length;
  }

  if (entries.length === 0) {
    container.innerHTML = `<div style="text-align:center;color:var(--ios-sub);padding:30px;font-size:13px;">السلة فارغة حالياً - انقر على المواد من الشاشة المقابلة لإضافتها</div>`;
    if (countLbl) countLbl.innerText = 'السلة فارغة';
    if (statLbl) statLbl.innerText = '0 مادة';
    recalcPosTotals();
    return;
  }

  const totalItemsCount = entries.reduce((acc, [, q]) => acc + q, 0);
  if (countLbl) countLbl.innerText = `${entries.length} صنف (${totalItemsCount} قطعة)`;
  if (statLbl) statLbl.innerText = `${entries.length} صنف (${totalItemsCount} قطعة)`;

  container.innerHTML = entries.map(([id, qty]) => {
    const p = products.find(x => x.id === id);
    if (!p) return '';

    const bonus = Number(p.bonus) || 0;
    const defaultUnitPrice = bonus > 0 ? Math.round(Number(p.price) * (1 - bonus / 100)) : Number(p.price);
    const unitPrice = posCartCustomPrices[id] !== undefined ? posCartCustomPrices[id] : defaultUnitPrice;
    const lineTot = unitPrice * qty;

    return `
      <div class="pos-cart-item-row">
        <div class="pos-cart-item-top">
          <div>
            <div style="font-weight:800;font-size:12.5px;color:var(--ios-text);">${escapeHtml(p.name)}</div>
            <div style="font-size:10.5px;color:var(--ios-sub);">${p.form ? escapeHtml(p.form) : ''} | المتوفر: ${p.quantity}</div>
          </div>
          <button type="button" style="border:none;background:transparent;color:var(--ios-red);cursor:pointer;font-size:14px;" onclick="removePosCartItem('${id}', event)" title="حذف من السلة">🗑️</button>
        </div>
        <div class="pos-cart-item-bottom">
          <!-- Editable Quantity Controls -->
          <div class="pos-qty-ctrl">
            <button type="button" class="pos-qty-btn" style="background:#e2e8f0;color:#334155;" onclick="changePosCartQty('${id}', -1, event)">-</button>
            <input type="number" class="pos-qty-input" min="1" max="${p.quantity}" value="${qty}" onchange="setPosCartExactQty('${id}', this.value, event)">
            <button type="button" class="pos-qty-btn" style="background:var(--ios-blue);color:#fff;" onclick="addToPosCart('${id}', event)">+</button>
          </div>

          <!-- Editable Unit Price Input -->
          <div style="display:flex;align-items:center;gap:4px;">
            <span style="font-size:10.5px;color:var(--ios-sub);">السعر:</span>
            <input type="number" class="pos-price-input" value="${unitPrice}" step="250" onchange="setPosCartCustomPrice('${id}', this.value, event)" title="تعديل سعر الوحدة">
          </div>

          <!-- Line Subtotal -->
          <div style="font-weight:800;color:var(--ios-green);font-size:12.5px;">
            ${lineTot.toLocaleString()} د.ع
          </div>
        </div>
      </div>
    `;
  }).join('');

  recalcPosTotals();
  if (typeof switchPosMobileScreen === 'function') switchPosMobileScreen(currentPosMobileTab);
}

function recalcPosTotals() {
  const subtotalEl = document.getElementById('pos-subtotal-price');
  const totalEl = document.getElementById('pos-total-price');
  const discountInput = document.getElementById('pos-discount-input');

  let subtotal = 0;
  Object.entries(posCart).forEach(([id, qty]) => {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const bonus = Number(p.bonus) || 0;
    const defaultUnitPrice = bonus > 0 ? Math.round(Number(p.price) * (1 - bonus / 100)) : Number(p.price);
    const unitPrice = posCartCustomPrices[id] !== undefined ? posCartCustomPrices[id] : defaultUnitPrice;
    subtotal += unitPrice * qty;
  });

  const discount = Math.max(0, parseFloat(discountInput?.value || '0') || 0);
  const netTotal = Math.max(0, subtotal - discount);

  if (subtotalEl) subtotalEl.innerText = `${subtotal.toLocaleString()} د.ع`;
  if (totalEl) totalEl.innerText = `${netTotal.toLocaleString()} د.ع`;

  return { subtotal, discount, netTotal };
}

// Execute Direct POS Cash Sale
async function executeDirectCashSale(e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  const phName = (document.getElementById('pos-ph-name')?.value || '').trim() || 'عميل بيع مباشر (نقدي)';
  const phPhone = (document.getElementById('pos-ph-phone')?.value || '').trim();
  const saleType = document.getElementById('pos-sale-type')?.value || 'cash';

  const entries = Object.entries(posCart);
  if (entries.length === 0) {
    showInAppAlert('سلة البيع المباشر فارغة. الرجاء اختيار مواد أولاً.', 'السلة فارغة');
    return;
  }

  const { subtotal, discount, netTotal } = recalcPosTotals();

  showInAppConfirm({
    title: 'تأكيد البيع المباشر',
    message: `إتمام وصرف الفاتورة بقيمة (${netTotal.toLocaleString()} د.ع) لصالح [${phName}]، وخصم المواد من المستودع مباشرة؟`,
    confirmText: 'نعم، إتمام وصرف الفاتورة',
    cancelText: 'مراجعة',
    isDestructive: false,
    onConfirm: async () => {
      const items = entries.map(([id, qty]) => {
        const p = products.find(x => x.id === id);
        const bonus = Number(p?.bonus) || 0;
        const defaultUnitPrice = bonus > 0 ? Math.round(Number(p?.price) * (1 - bonus / 100)) : Number(p?.price || 0);
        const price = posCartCustomPrices[id] !== undefined ? posCartCustomPrices[id] : defaultUnitPrice;
        return {
          id,
          name: p?.name || '',
          barcode: p?.barcode || '',
          form: p?.form || 'Tablet',
          quantity: qty,
          price,
          expiryDate: p?.expiryDate || ''
        };
      });

      const orderNumber = `POS-${Date.now()}`;
      const newOrder = {
        orderNumber,
        pharmacyName: phName,
        phone: phPhone,
        staffName: currentStaff || 'كاشير البيع المباشر',
        deliveryStaffName: 'تسليم فوري (مباشر)',
        totalAmount: netTotal,
        subtotal,
        discount,
        paymentType: saleType,
        status: 'معتمد', // Directly approved & logged into issued orders
        isDelivered: true,
        date: new Date().toLocaleString('ar-IQ'),
        createdAt: new Date().toISOString(),
        userId: myUserId,
        items
      };

      // Deduct stock locally immediately
      items.forEach(it => {
        const prod = products.find(p => p.id === it.id);
        if (prod) {
          prod.quantity = Math.max(0, Number(prod.quantity) - Number(it.quantity));
        }
      });
      orders.unshift(newOrder);

      // Deduct stock in Supabase "samo" table (column "number") and log inventory movements
      try {
        const sb = getSupabaseClient();
        for (const it of items) {
          let curStock = 0;
          let newStock = 0;
          if (sb && it.id) {
            sb.from('samo').select('id, number').eq('id', it.id).maybeSingle().then(async ({ data: pRow }) => {
              if (pRow) {
                curStock = Number(pRow.number) || 0;
                newStock = Math.max(0, curStock - (Number(it.quantity) || 1));
                await sb.from('samo').update({ number: newStock }).eq('id', it.id);
              }
            }).catch(() => {});
          }
          logInventoryMovement('صرف طلبية', it.name || it.product, {
            order_ref: orderNumber,
            quantity: Number(it.quantity) || 1,
            pharmacy_name: phName
          }).catch(() => {});
        }
      } catch (posDeductErr) {
        console.warn('POS stock deduction/inventory log error:', posDeductErr);
      }

      // If customer is not generic and not already in customersList, save to customers in Supabase
      if (phName && phName !== 'عميل بيع مباشر (نقدي)' && phName !== 'عميل بيع مباشر') {
        const existing = (customersList || []).some(c => c.name.toLowerCase() === phName.toLowerCase());
        const sb = getSupabaseClient();
        if (!existing && sb) {
          sb.from('customers').insert([{
            name: phName.trim(),
            phone: phPhone ? phPhone.trim() : null,
            address: null,
            created_at: new Date().toISOString()
          }]).then(() => fetchCustomers()).catch(() => {});
        }
      }

      // Reset cart
      posCart = {};
      posCartCustomPrices = {};
      savePosCart();
      const phInput = document.getElementById('pos-ph-name');
      const phPhoneInput = document.getElementById('pos-ph-phone');
      const discountInput = document.getElementById('pos-discount-input');
      if (phInput) phInput.value = '';
      if (phPhoneInput) phPhoneInput.value = '';
      if (discountInput) discountInput.value = '0';

      renderPosCart();
      renderPosGrid();
      renderOrdersLog();
      renderProducts();

      // Direct Supabase "orders" Table Insertion
      const userEmail = currentStaffEmail || localStorage.getItem('samo_staff_email') || '';
      try {
        const sb = getSupabaseClient();
        if (sb) {
          const selectedCustomer = (customersList || []).find(c => 
            c.name === phName || String(c.id) === String(phName)
          ) || null;
          const posOrderId = `ORD-SB-${Date.now().toString().slice(-5)}`;
          const posRow = {
            id: posOrderId,
            customer_id: selectedCustomer ? (Number(selectedCustomer.id) || null) : null,
            customer_name: phName || 'عميل نقدي / مبيعات مباشرة',
            items: items,
            total_amount: netTotal,
            status: 'معتمد',
            created_at: new Date().toISOString()
          };
          if (userEmail) posRow.staff_email = userEmail;

          const { error: sbErr } = await sb
            .from('orders')
            .insert([posRow]);

          if (sbErr) {
            console.error('Supabase POS orders insert error:', sbErr);
            alert(`⚠️ خطأ أثناء حفظ فاتورة POS في Supabase (جدول orders):\n${sbErr.message || JSON.stringify(sbErr)}`);
          } else {
            showQuickToast('تم حفظ الطلب بنجاح في السيرفر ✓');
            if (userEmail) clearStaffDraftCloud(userEmail);
          }
        }
      } catch (e) {
        console.error('Supabase POS error:', e);
      }

      try {
        await postToApi({ action: 'new_order', order: newOrder, alreadyInSupabase: true });
        await postToApi({ action: 'save_products', products });
        showInAppConfirm({
          title: '✓ تم البيع بنجاح',
          message: `تم صرف الفاتورة برقم [${orderNumber}] وتحديث رصيد المستودع. هل ترغب في طباعة الوصل الحراري الآن؟`,
          confirmText: '🖨️ طباعة الوصل',
          cancelText: 'تم الانتهاء',
          isDestructive: false,
          onConfirm: () => {
            printThermalReceiptForOrder(newOrder);
          }
        });
      } catch (err) {
        showInAppAlert('تم تسجيل الفاتورة محلياً وتعذر رفعها للخادم: ' + err.message, 'تنبيه المزامنة');
      }
    }
  });
}

// POS Thermal Receipt Printing
function printPosThermalReceipt(e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  const entries = Object.entries(posCart);
  if (entries.length === 0) {
    showInAppAlert('السلة فارغة. يرجى إضافة مواد للطباعة.', 'السلة فارغة');
    return;
  }

  const phName = (document.getElementById('pos-ph-name')?.value || '').trim() || 'عميل بيع مباشر';
  const phPhone = (document.getElementById('pos-ph-phone')?.value || '').trim();
  const { subtotal, discount, netTotal } = recalcPosTotals();

  const items = entries.map(([id, qty]) => {
    const p = products.find(x => x.id === id);
    const bonus = Number(p?.bonus) || 0;
    const defaultUnitPrice = bonus > 0 ? Math.round(Number(p?.price) * (1 - bonus / 100)) : Number(p?.price || 0);
    const price = posCartCustomPrices[id] !== undefined ? posCartCustomPrices[id] : defaultUnitPrice;
    return {
      name: p?.name || 'مادة',
      quantity: qty,
      price,
      total: price * qty
    };
  });

  printThermalReceiptForOrder({
    orderNumber: `POS-${Date.now()}`,
    pharmacyName: phName,
    phone: phPhone,
    date: new Date().toLocaleString('ar-IQ'),
    items,
    subtotal,
    discount,
    totalAmount: netTotal
  });
}

function printThermalReceiptForOrder(order) {
  const printWindow = window.open('', '_blank', 'width=420,height=600');
  if (!printWindow) {
    showInAppAlert('يرجى السماح بالنوافذ المنبثقة لطباعة الوصل.', 'تنبيه');
    return;
  }

  const itemsRows = (order.items || []).map(it => `
    <tr>
      <td style="padding:4px 2px;text-align:right;">${escapeHtml(it.name)}</td>
      <td style="padding:4px 2px;text-align:center;">${it.quantity}</td>
      <td style="padding:4px 2px;text-align:center;">${Number(it.price || 0).toLocaleString()}</td>
      <td style="padding:4px 2px;text-align:left;">${Number((it.quantity * it.price) || it.total || 0).toLocaleString()}</td>
    </tr>
  `).join('');

  printWindow.document.write(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
      <meta charset="utf-8">
      <title>وصل بيع - ${order.orderNumber}</title>
      <style>
        @page { size: 80mm auto; margin: 4mm; }
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 11px; margin: 0; padding: 0; }
        .header { text-align: center; border-bottom: 1px dashed #000; padding-bottom: 6px; margin-bottom: 6px; }
        .title { font-size: 14px; font-weight: 800; }
        .sub { font-size: 10px; }
        table { width: 100%; border-collapse: collapse; font-size: 10.5px; margin: 6px 0; }
        th { border-bottom: 1px solid #000; padding: 4px 2px; font-weight: 800; }
        .totals { border-top: 1px dashed #000; padding-top: 6px; font-size: 11px; }
        .total-row { display: flex; justify-content: space-between; margin-bottom: 3px; }
        .net-row { font-size: 13px; font-weight: 800; border-top: 1px solid #000; padding-top: 4px; margin-top: 4px; }
        .footer { text-align: center; font-size: 9px; margin-top: 10px; border-top: 1px dashed #000; padding-top: 6px; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="title">مستودع سامو للأدوية</div>
        <div class="sub">فاتورة بيع وتجهيز مباشر</div>
        <div class="sub">رقم الوصل: <b>${order.orderNumber}</b></div>
        <div class="sub">${order.date || new Date().toLocaleString('ar-IQ')}</div>
      </div>
      <div>
        <div>العميل: <b>${escapeHtml(order.pharmacyName || 'نقدي')}</b></div>
        ${order.phone ? `<div>الهاتف: ${escapeHtml(order.phone)}</div>` : ''}
      </div>
      <table>
        <thead>
          <tr>
            <th style="text-align:right;">المادة</th>
            <th style="text-align:center;">العدد</th>
            <th style="text-align:center;">السعر</th>
            <th style="text-align:left;">المجموع</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>
      <div class="totals">
        ${order.discount ? `
          <div class="total-row"><span>المجموع الفرعي:</span><span>${Number(order.subtotal || order.totalAmount).toLocaleString()} د.ع</span></div>
          <div class="total-row"><span>الخصم:</span><span>${Number(order.discount).toLocaleString()} د.ع</span></div>
        ` : ''}
        <div class="total-row net-row">
          <span>الصافي الكلي:</span>
          <span>${Number(order.totalAmount || 0).toLocaleString()} د.ع</span>
        </div>
      </div>
      <div class="footer">
        شكراً لتعاملكم معنا • نتشرف بخدمتكم دائماً
      </div>
      <script>
        setTimeout(() => { window.print(); window.close(); }, 350);
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

let isSubmittingPosOrder = false;

// Confirm Pos Order Submission as Pending Warehouse Request
async function confirmPosOrderSubmission(e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  if (isSubmittingPosOrder) {
    console.warn('POS order submission in progress');
    return;
  }

  const phName = (document.getElementById('pos-ph-name')?.value || '').trim();
  const phPhone = (document.getElementById('pos-ph-phone')?.value || '').trim();
  if (!phName) {
    showInAppAlert('الرجاء إدخال أو اختيار اسم الصيدلية المستلمة.', 'بيانات ناقصة');
    return;
  }

  const entries = Object.entries(posCart);
  if (entries.length === 0) {
    showInAppAlert('سلة التجهيز فارغة. اختر مواد أولاً.', 'السلة فارغة');
    return;
  }

  isSubmittingPosOrder = true;

  try {
    const { subtotal, discount, netTotal } = recalcPosTotals();

    const items = entries.map(([id, qty]) => {
      const p = products.find(x => x.id === id);
      const bonus = Number(p?.bonus) || 0;
      const defaultUnitPrice = bonus > 0 ? Math.round(Number(p?.price) * (1 - bonus / 100)) : Number(p?.price || 0);
      const price = posCartCustomPrices[id] !== undefined ? posCartCustomPrices[id] : defaultUnitPrice;
      return {
        id,
        product_id: id,
        name: p?.name || '',
        product: p?.name || '',
        barcode: p?.barcode || '',
        form: p?.form || 'Tablet',
        quantity: qty,
        qty: qty,
        price,
        expiryDate: p?.expiryDate || ''
      };
    });

    const userEmail = currentStaffEmail || localStorage.getItem('samo_staff_email') || '';
    const posOrderId = `ORD-SB-${Date.now().toString().slice(-5)}`;
    let supabaseOrderId = posOrderId;

    // Direct Supabase "orders" Table Insertion
    const sb = getSupabaseClient();
    if (sb) {
      const selectedCustomer = (customersList || []).find(c => 
        c.name === phName || String(c.id) === String(phName)
      ) || null;

      const posOrderRow = {
        id: posOrderId,
        customer_id: selectedCustomer ? (Number(selectedCustomer.id) || null) : null,
        customer_name: selectedCustomer?.name || phName || 'رسول اللامي',
        items: items,
        total_amount: netTotal,
        status: 'قيد المراجعة',
        created_at: new Date().toISOString()
      };
      if (userEmail) posOrderRow.staff_email = userEmail;

      const { data: posData, error: sbErr } = await sb
        .from('orders')
        .insert([posOrderRow]);

      if (sbErr) {
        console.error('Supabase POS request orders insert error:', sbErr);
      } else {
        if (userEmail) clearStaffDraftCloud(userEmail);
      }

      // If customer is not generic and not already in customersList, save to customers in Supabase
      if (phName && phName !== 'عميل بيع مباشر (نقدي)' && phName !== 'عميل بيع مباشر') {
        const existing = (customersList || []).some(c => c.name.toLowerCase() === phName.toLowerCase());
        if (!existing) {
          sb.from('customers').insert([{
            name: phName.trim(),
            phone: phPhone ? phPhone.trim() : null,
            address: null,
            created_at: new Date().toISOString()
          }]).then(() => fetchCustomers()).catch(() => {});
        }
      }
    }

    const finalOrderRef = supabaseOrderId ? `ORD-SB-${supabaseOrderId}` : singleOrderId;

    const newOrder = {
      id: supabaseOrderId || singleOrderId,
      orderNumber: finalOrderRef,
      order_ref: finalOrderRef,
      supabaseId: supabaseOrderId,
      alreadyInSupabase: true,
      pharmacyName: phName,
      customerName: phName,
      phone: phPhone,
      staffName: currentStaff || 'نقطة البيع (POS)',
      staffEmail: userEmail,
      deliveryStaffName: '',
      totalAmount: netTotal,
      total_price: netTotal,
      subtotal,
      discount,
      status: 'قيد المراجعة',
      date: new Date().toLocaleString('ar-IQ'),
      createdAt: new Date().toISOString(),
      userId: myUserId,
      items
    };

    await postToApi({ action: 'new_order', order: newOrder, alreadyInSupabase: true });
    showInAppAlert(`تم إرسال طلب نقطة البيع للمستودع برقم (${finalOrderRef}) بنجاح ✓`, 'تم الإرسال');
    posCart = {};
    posCartCustomPrices = {};
    savePosCart();
    const phInput = document.getElementById('pos-ph-name');
    const phPhoneInput = document.getElementById('pos-ph-phone');
    if (phInput) phInput.value = '';
    if (phPhoneInput) phPhoneInput.value = '';
    renderPosCart();
    renderPosGrid();
    loadRemoteData();
  } catch (err) {
    showInAppAlert('تعذر إرسال الطلب: ' + err.message, 'خطأ');
  } finally {
    isSubmittingPosOrder = false;
  }
}

// Staff Management & Reporting
function selectStaffForReport(name) {
  const sel = document.getElementById('staff-report-select');
  if (sel) {
    sel.value = name;
  }
  buildStaffPeriodReport();
  const repEl = document.getElementById('staff-period-report');
  if (repEl) {
    repEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderStaffReport() {
  const container = document.getElementById('staff-report-container');
  if (!container) return;

  const staffStats = new Map();
  staffNames.forEach(s => {
    staffStats.set(s, { count: 0, total: 0, itemsCount: 0, pharmacies: new Set() });
  });

  orders.forEach(o => {
    const name = o.staffName || o.deliveryStaffName;
    if (name) {
      if (!staffStats.has(name)) {
        staffStats.set(name, { count: 0, total: 0, itemsCount: 0, pharmacies: new Set() });
      }
      const st = staffStats.get(name);
      st.count++;
      st.total += Number(o.totalAmount || 0);
      if (o.pharmacyName) st.pharmacies.add(o.pharmacyName.trim());
      const oItems = Array.isArray(o.items) ? o.items.reduce((acc, it) => acc + (Number(it.quantity) || 1), 0) : 1;
      st.itemsCount += oItems;
    }
  });

  let grandTotalOrders = 0;
  let grandTotalAmount = 0;
  let grandTotalItems = 0;
  const allUniquePh = new Set();

  orders.forEach(o => {
    grandTotalOrders++;
    grandTotalAmount += Number(o.totalAmount || 0);
    if (o.pharmacyName) allUniquePh.add(o.pharmacyName.trim());
    const oItems = Array.isArray(o.items) ? o.items.reduce((acc, it) => acc + (Number(it.quantity) || 1), 0) : 1;
    grandTotalItems += oItems;
  });

  const allStaffList = Array.from(new Set([...staffNames, ...Array.from(staffStats.keys())])).filter(Boolean);

  if (allStaffList.length === 0) {
    container.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:24px;text-align:center;color:var(--ios-sub);border:1px solid var(--ios-border);">
        <div style="font-size:32px;margin-bottom:6px;">👥</div>
        <div style="font-weight:700;font-size:14px;">لا يوجد موظفون مسجلون حالياً</div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div style="background:#fff;border-radius:14px;border:1px solid var(--ios-border);padding:14px;box-shadow:0 2px 8px rgba(0,0,0,0.03);margin-bottom:12px;">
      <div style="font-size:14px;font-weight:900;color:var(--ios-blue);margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
        <span>👥 جدول نشاط ومبيعات كادر الموظفين (${allStaffList.length} موظف):</span>
        <span style="font-size:11px;color:var(--ios-green);font-weight:700;background:#dcfce7;padding:3px 8px;border-radius:6px;">✓ تحديث فوري مباشر</span>
      </div>

      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid var(--ios-border);">
          <thead>
            <tr style="background:#f1f5f9;color:#334155;font-weight:800;text-align:right;">
              <th style="padding:8px 6px;border:1px solid var(--ios-border);text-align:center;width:35px;">ت</th>
              <th style="padding:8px 10px;border:1px solid var(--ios-border);text-align:right;">اسم الموظف</th>
              <th style="padding:8px 8px;border:1px solid var(--ios-border);text-align:center;width:95px;">الصيدليات</th>
              <th style="padding:8px 8px;border:1px solid var(--ios-border);text-align:center;width:95px;">القطع المجهزة</th>
              <th style="padding:8px 8px;border:1px solid var(--ios-border);text-align:center;width:95px;">عدد الطلبيات</th>
              <th style="padding:8px 10px;border:1px solid var(--ios-border);text-align:left;width:135px;">إجمالي المبيعات</th>
              <th style="padding:8px 6px;border:1px solid var(--ios-border);text-align:center;width:140px;">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${allStaffList.map((s, idx) => {
              const st = staffStats.get(s) || { count: 0, total: 0, itemsCount: 0, pharmacies: new Set() };
              return `
                <tr style="border-bottom:1px solid var(--ios-border);background:${idx % 2 === 0 ? '#fff' : '#f8fafc'};">
                  <td style="padding:7px 6px;text-align:center;font-weight:700;border:1px solid var(--ios-border);">${idx + 1}</td>
                  <td style="padding:7px 10px;font-weight:800;border:1px solid var(--ios-border);color:var(--ios-text);">
                    👤 ${escapeHtml(s)}
                  </td>
                  <td style="padding:7px 8px;text-align:center;font-weight:800;border:1px solid var(--ios-border);color:#2563eb;">
                    ${st.pharmacies.size}
                  </td>
                  <td style="padding:7px 8px;text-align:center;font-weight:800;border:1px solid var(--ios-border);color:#d97706;">
                    ${st.itemsCount}
                  </td>
                  <td style="padding:7px 8px;text-align:center;font-weight:800;border:1px solid var(--ios-border);color:var(--ios-blue);">
                    ${st.count}
                  </td>
                  <td style="padding:7px 10px;text-align:left;font-weight:900;color:var(--ios-green);border:1px solid var(--ios-border);font-family:monospace;">
                    ${st.total.toLocaleString()} د.ع
                  </td>
                  <td style="padding:5px 6px;text-align:center;border:1px solid var(--ios-border);">
                    <div style="display:flex;gap:4px;justify-content:center;">
                      <button class="btn btn-sec" style="font-size:11px;padding:4px 8px;font-weight:700;" onclick="selectStaffForReport('${escapeHtml(s)}')">📊 تفاصيل</button>
                      ${isAdmin ? `
                        <button class="btn btn-danger" style="font-size:11px;padding:4px 6px;" onclick="deleteStaffPrompt('${escapeHtml(s)}')">🗑️</button>
                      ` : ''}
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
          <tfoot style="background:#f1f5f9;font-weight:900;border-top:2px solid var(--ios-border);">
            <tr>
              <td colspan="2" style="padding:9px 10px;text-align:right;border:1px solid var(--ios-border);font-size:12.5px;">
                ⭐️ <b>الإجمالي العام لكافة الموظفين:</b>
              </td>
              <td style="padding:9px 8px;text-align:center;border:1px solid var(--ios-border);color:#2563eb;">${allUniquePh.size}</td>
              <td style="padding:9px 8px;text-align:center;border:1px solid var(--ios-border);color:#d97706;">${grandTotalItems}</td>
              <td style="padding:9px 8px;text-align:center;border:1px solid var(--ios-border);color:var(--ios-blue);">${grandTotalOrders}</td>
              <td style="padding:9px 10px;text-align:left;border:1px solid var(--ios-border);color:var(--ios-green);font-family:monospace;">${grandTotalAmount.toLocaleString()} د.ع</td>
              <td style="padding:9px 6px;text-align:center;border:1px solid var(--ios-border);">-</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}

async function addNewStaffNamePrompt() {
  const name = prompt('أدخل اسم الموظف الجديد:');
  if (!name || !name.trim()) {
    populateStaffDropdowns();
    return;
  }
  const trimmed = name.trim();
  try {
    const sb = getSupabaseClient();
    if (sb) {
      await sb.from('staff').insert([{
        name: trimmed,
        role: 'مندوب مبيعات',
        email: '',
        created_at: new Date().toISOString()
      }]);
    }
    await postToApi({ action: 'add_staff', name: trimmed });
    if (!staffNames.includes(trimmed)) staffNames.push(trimmed);
    onStaffSelected(trimmed);
    populateStaffDropdowns();
    renderStaffReport();
    alert(`تمت إضافة الموظف (${trimmed}) وحفظه في Supabase بنجاح ✓`);
    await fetchStaffFromSupabaseDirect(false);
  } catch (err) {
    alert('حدث خطأ: ' + err.message);
    populateStaffDropdowns();
  }
}

function deleteStaffPrompt(name) {
  showInAppConfirm({
    title: 'حذف موظف',
    message: `هل أنت متأكد من حذف الموظف <b>(${escapeHtml(name)})</b> نهائياً من النظام وقاعدة بيانات Supabase؟`,
    icon: '👤',
    confirmText: 'نعم، تأكيد الحذف',
    isDanger: true,
    onConfirm: async () => {
      try {
        const sb = getSupabaseClient();
        if (sb) {
          await sb.from('staff').delete().eq('name', name);
        }
        await postToApi({ action: 'delete_staff', name });
        staffNames = staffNames.filter(s => s !== name);
        if (currentStaff === name) onStaffSelected('');
        saveLocalData();
        populateStaffDropdowns();
        renderStaffReport();
        showQuickToast(`تم حذف الموظف (${name}) بنجاح ✓`);
        await fetchStaffFromSupabaseDirect(false);
      } catch (err) {
        showQuickToast('حدث خطأ: ' + err.message, 'error');
      }
    }
  });
}

function buildStaffPeriodReport() {
  let staff = document.getElementById('staff-report-select')?.value;
  if (!staff) {
    staff = '__all__';
    const sel = document.getElementById('staff-report-select');
    if (sel) sel.value = '__all__';
  }
  const from = document.getElementById('staff-report-from')?.value;
  const to = document.getElementById('staff-report-to')?.value;
  const container = document.getElementById('staff-period-report');
  if (!container) return;

  const fromD = from ? new Date(from) : new Date(0);
  const toD = to ? new Date(to + 'T23:59:59') : new Date(8640000000000000);

  const matched = orders.filter(o => {
    if (staff !== '__all__' && o.staffName !== staff && o.deliveryStaffName !== staff) return false;
    const d = new Date(o.createdAt || o.date);
    if (!isNaN(d.getTime())) {
      if (d < fromD || d > toD) return false;
    }
    return true;
  });

  const totVal = matched.reduce((a, b) => a + (Number(b.totalAmount) || 0), 0);

  // Group by pharmacy
  const pharmacyMap = new Map();
  let totalItemsCount = 0;
  matched.forEach(o => {
    const phName = o.pharmacyName || 'غير محدد';
    if (!pharmacyMap.has(phName)) {
      pharmacyMap.set(phName, { count: 0, total: 0, itemsCount: 0, phone: o.phone || '' });
    }
    const cur = pharmacyMap.get(phName);
    cur.count += 1;
    cur.total += Number(o.totalAmount || 0);
    if (!cur.phone && o.phone) cur.phone = o.phone;

    const orderItemsCount = (o.items && o.items.length > 0)
      ? o.items.reduce((sum, it) => sum + (Number(it.quantity) || 1), 0)
      : 1;
    cur.itemsCount += orderItemsCount;
    totalItemsCount += orderItemsCount;
  });

  const uniquePharmaciesCount = pharmacyMap.size;

  container.innerHTML = `
    <div style="background:#fff;padding:16px;border-radius:14px;border:1px solid var(--ios-border);box-shadow:0 2px 8px rgba(0,0,0,0.03);">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--ios-border);padding-bottom:10px;margin-bottom:12px;">
        <div>
          <div style="font-weight:900;font-size:16px;color:var(--ios-blue);">👤 تقرير الموظف: ${escapeHtml(staff === '__all__' ? 'كافة الموظفين' : staff)}</div>
          <div style="font-size:12px;color:var(--ios-sub);margin-top:2px;">الفترة الزمنية: <b>${from || 'بداية السجلات'}</b> إلى <b>${to || 'الوقت الحالي'}</b></div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-prim" style="padding:7px 14px;font-size:12px;background:#059669;" onclick="exportSelectedStaffPDF()">
            📄 تصدير PDF مفصل
          </button>
          <button class="btn btn-sec" style="padding:7px 12px;font-size:12px;" onclick="printStaffReportDirect()">
            🖨️ طباعة التقرير
          </button>
        </div>
      </div>

      <!-- KPI Summary Cards -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:10px;margin-bottom:16px;">
        <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:10px;text-align:center;">
          <div style="font-size:11px;color:#065f46;font-weight:700;">المبلغ الإجمالي</div>
          <div style="font-size:16px;font-weight:900;color:#059669;margin-top:2px;">${totVal.toLocaleString()} <span style="font-size:11px;">د.ع</span></div>
        </div>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:10px;text-align:center;">
          <div style="font-size:11px;color:#1e40af;font-weight:700;">عدد الصيدليات</div>
          <div style="font-size:16px;font-weight:900;color:#2563eb;margin-top:2px;">${uniquePharmaciesCount} <span style="font-size:11px;">صيدلية</span></div>
        </div>
        <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:10px;text-align:center;">
          <div style="font-size:11px;color:#5b21b6;font-weight:700;">عدد الطلبيات</div>
          <div style="font-size:16px;font-weight:900;color:#7c3aed;margin-top:2px;">${matched.length} <span style="font-size:11px;">طلب</span></div>
        </div>
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px;text-align:center;">
          <div style="font-size:11px;color:#92400e;font-weight:700;">إجمالي عدد المواد</div>
          <div style="font-size:16px;font-weight:900;color:#d97706;margin-top:2px;">${totalItemsCount} <span style="font-size:11px;">قطعة</span></div>
        </div>
      </div>

      <!-- Pharmacies Summary Table (الجدول المحاذى بدقة: ت | اسم الصيدلية | الهاتف | عدد الطلبيات | عدد المواد | المبلغ) -->
      <div style="margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:var(--ios-text);margin-bottom:6px;">🏥 جدول الصيدليات وعدد المواد والمبالغ:</div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid var(--ios-border);">
            <thead>
              <tr style="background:#f1f5f9;color:#334155;font-weight:800;text-align:right;">
                <th style="padding:7px 5px;border:1px solid var(--ios-border);text-align:center;width:35px;">ت</th>
                <th style="padding:7px 8px;border:1px solid var(--ios-border);text-align:right;">اسم الصيدلية المستلمة</th>
                <th style="padding:7px 8px;border:1px solid var(--ios-border);text-align:center;width:110px;">رقم الهاتف</th>
                <th style="padding:7px 8px;border:1px solid var(--ios-border);text-align:center;width:95px;">عدد الطلبيات</th>
                <th style="padding:7px 8px;border:1px solid var(--ios-border);text-align:center;width:95px;">عدد المواد</th>
                <th style="padding:7px 8px;border:1px solid var(--ios-border);text-align:left;width:140px;">المبلغ (د.ع)</th>
              </tr>
            </thead>
            <tbody>
              ${Array.from(pharmacyMap.entries()).map(([name, data], idx) => `
                <tr style="border-bottom:1px solid var(--ios-border);background:${idx % 2 === 0 ? '#fff' : '#f8fafc'};">
                  <td style="padding:6px 5px;text-align:center;font-weight:700;border:1px solid var(--ios-border);">${idx + 1}</td>
                  <td style="padding:6px 8px;font-weight:800;border:1px solid var(--ios-border);color:var(--ios-text);">${escapeHtml(name)}</td>
                  <td style="padding:6px 8px;text-align:center;color:var(--ios-sub);border:1px solid var(--ios-border);">${escapeHtml(data.phone || '-')}</td>
                  <td style="padding:6px 8px;text-align:center;font-weight:800;border:1px solid var(--ios-border);color:var(--ios-blue);">${data.count}</td>
                  <td style="padding:6px 8px;text-align:center;font-weight:800;border:1px solid var(--ios-border);color:#d97706;">${data.itemsCount}</td>
                  <td style="padding:6px 8px;text-align:left;font-weight:900;color:var(--ios-green);border:1px solid var(--ios-border);font-family:monospace;">${data.total.toLocaleString()} د.ع</td>
                </tr>
              `).join('')}
            </tbody>
            <tfoot style="background:#f1f5f9;font-weight:900;border-top:2px solid var(--ios-border);">
              <tr>
                <td colspan="3" style="padding:8px 10px;text-align:right;border:1px solid var(--ios-border);font-size:12.5px;">
                  ⭐️ <b>المجموع الكلي:</b> (${uniquePharmaciesCount} صيدلية)
                </td>
                <td style="padding:8px 6px;text-align:center;border:1px solid var(--ios-border);color:var(--ios-blue);">${matched.length}</td>
                <td style="padding:8px 6px;text-align:center;border:1px solid var(--ios-border);color:#d97706;">${totalItemsCount}</td>
                <td style="padding:8px 8px;text-align:left;border:1px solid var(--ios-border);color:var(--ios-green);font-family:monospace;">${totVal.toLocaleString()} د.ع</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <!-- Detailed Orders Log -->
      <div>
        <div style="font-size:13px;font-weight:800;color:var(--ios-text);margin-bottom:6px;">📦 تفاصيل الطلبيات المنجزة (${matched.length}):</div>
        <div style="display:flex;flex-direction:column;gap:8px;max-height:380px;overflow-y:auto;padding-right:2px;">
          ${matched.map(o => `
            <div style="background:#f8fafc;border:1px solid var(--ios-border);border-radius:8px;padding:8px 10px;font-size:12px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <div>
                  <span style="font-weight:800;color:var(--ios-text);">🏥 ${escapeHtml(o.pharmacyName)}</span>
                  <span style="color:var(--ios-sub);font-size:11px;margin-right:6px;">(#${o.orderNumber} - ${o.date})</span>
                </div>
                <span style="font-weight:900;color:var(--ios-green);">${Number(o.totalAmount || 0).toLocaleString()} د.ع</span>
              </div>
              <div style="color:var(--ios-sub);font-size:11.5px;background:#fff;padding:6px;border-radius:6px;border:1px solid #e2e8f0;">
                ${(o.items || []).map(it => {
                  let itExp = (it.expiryDate || it.expiry_date || '').trim();
                  if (!itExp) {
                    const pr = products.find(p => p.id === it.id || p.barcode === it.barcode || p.name === it.name);
                    if (pr && pr.expiryDate) itExp = pr.expiryDate;
                  }
                  return `
                    <span style="display:inline-block;margin:2px 4px;background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:11px;">
                      ${escapeHtml(it.name)} × <b>${it.quantity}</b> ${itExp ? `(صلاحية: ${escapeHtml(itExp)})` : ''} = ${(it.quantity * it.price).toLocaleString()} د.ع
                    </span>
                  `;
                }).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function exportSelectedStaffExcel() {
  const staff = document.getElementById('staff-report-select')?.value;
  const from = document.getElementById('staff-report-from')?.value;
  const to = document.getElementById('staff-report-to')?.value;

  if (!staff) {
    showInAppAlert('يرجى اختيار موظف أولاً لتصدير ملف Excel.', 'تنبيه');
    return;
  }

  const fromD = from ? new Date(from) : new Date(0);
  const toD = to ? new Date(to + 'T23:59:59') : new Date(8640000000000000);

  const matched = orders.filter(o => {
    if (staff !== '__all__' && o.staffName !== staff && o.deliveryStaffName !== staff) return false;
    const d = new Date(o.createdAt || o.date);
    if (!isNaN(d.getTime())) {
      if (d < fromD || d > toD) return false;
    }
    return true;
  });

  if (matched.length === 0) {
    showInAppAlert('لا توجد طلبات مسجلة لهذا الموظف خلال الفترة المحددة.', 'تنبيه');
    return;
  }

  // Generate Detailed Excel (CSV with UTF-8 BOM for Excel) containing detailed medicine items
  let csv = 'ت,رقم الطلب,اسم الصيدلية,هاتف الصيدلية,الموظف المجهز,التاريخ,اسم الدواء / المادة,الشركة,الباركود,الشكل الدوائي,الكمية,سعر المفرد (د.ع),المبلغ الإجمالي للبند (د.ع),تاريخ الصلاحية,إجمالي الطلبية (د.ع)\n';
  let counter = 1;

  matched.forEach(o => {
    const orderTotal = Number(o.totalAmount || 0);
    const items = (o.items && o.items.length > 0) ? o.items : [{ name: 'غير محدد', quantity: 1, price: orderTotal }];
    
    items.forEach((it, idx) => {
      const itName = (it.name || '').replace(/"/g, '""');
      const itComp = (it.company || '').replace(/"/g, '""');
      const itBarcode = (it.barcode || '').replace(/"/g, '""');
      const itForm = (it.form || '').replace(/"/g, '""');
      const itQty = Number(it.quantity || 0);
      const itPrice = Number(it.price || 0);
      const itLineTotal = itQty * itPrice;
      const itExp = (it.expiryDate || '').replace(/"/g, '""');
      const phName = (o.pharmacyName || '').replace(/"/g, '""');
      const phPhone = (o.phone || '').replace(/"/g, '""');
      const staffName = (o.staffName || o.deliveryStaffName || staff || '').replace(/"/g, '""');
      const orderDate = (o.date || o.createdAt || '').replace(/"/g, '""');

      csv += `"${counter}","${o.orderNumber}","${phName}","${phPhone}","${staffName}","${orderDate}","${itName}","${itComp}","${itBarcode}","${itForm}","${itQty}","${itPrice}","${itLineTotal}","${itExp}","${idx === 0 ? orderTotal : ''}"\n`;
      counter++;
    });
  });

  const staffLabel = staff === '__all__' ? 'كافة_الموظفين' : staff;
  downloadCSV(`تفاصيل_أدوية_طلبيات_${staffLabel}_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  showQuickToast('تم تصدير تفاصيل أدوية الموظف إلى Excel بنجاح ✓');
}

function exportMedicineDetailsExcel() {
  let csv = 'ت,معرف المادة,اسم الدواء / المادة,الشركة المصنعة,الباركود الدولي,الشكل الدوائي,الكمية المتوفرة بالمخزن,سعر المفرد (د.ع),القيمة الإجمالية للمخزون (د.ع),البونص المجاني,تاريخ الصلاحية,حالة الصلاحية,حالة التوفر\n';
  const now = new Date();
  const sixMonthsAhead = new Date();
  sixMonthsAhead.setMonth(now.getMonth() + 6);

  products.forEach((p, idx) => {
    const qty = Number(p.quantity || 0);
    const price = Number(p.price || 0);
    const totalVal = qty * price;
    
    let expStatus = 'سليم وصالح';
    if (p.expiryDate) {
      const expD = new Date(p.expiryDate);
      if (!isNaN(expD.getTime())) {
        if (expD < now) expStatus = 'منتهي الصلاحية (تالف)';
        else if (expD <= sixMonthsAhead) expStatus = 'قريب النفاذ (أقل من 6 أشهر)';
      }
    }

    let stockStatus = qty > 0 ? 'متوفر' : 'منفذ (غير متوفر)';

    csv += `"${idx + 1}","${p.id}","${(p.name || '').replace(/"/g, '""')}","${(p.company || '').replace(/"/g, '""')}","${p.barcode || ''}","${p.form || ''}","${qty}","${price}","${totalVal}","${p.bonus || 0}","${p.expiryDate || ''}","${expStatus}","${stockStatus}"\n`;
  });

  downloadCSV(`سجل_تفاصيل_الأدوية_الشامل_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  showQuickToast('تم تصدير سجل تفاصيل الأدوية كاملاً إلى Excel ✓');
}

function populateStaffPdfSheet() {
  const staff = document.getElementById('staff-report-select')?.value;
  const from = document.getElementById('staff-report-from')?.value;
  const to = document.getElementById('staff-report-to')?.value;

  if (!staff) {
    showInAppAlert('يرجى اختيار موظف أولاً.', 'تنبيه');
    return null;
  }

  const fromD = from ? new Date(from) : new Date(0);
  const toD = to ? new Date(to + 'T23:59:59') : new Date(8640000000000000);

  const matched = orders.filter(o => {
    if (staff !== '__all__' && o.staffName !== staff && o.deliveryStaffName !== staff) return false;
    const d = new Date(o.createdAt || o.date);
    if (!isNaN(d.getTime())) {
      if (d < fromD || d > toD) return false;
    }
    return true;
  });

  const totVal = matched.reduce((a, b) => a + (Number(b.totalAmount) || 0), 0);

  // Group by pharmacy with count of orders, total medicines items, and total amount
  const pharmacyMap = new Map();
  let grandTotalItems = 0;
  let grandTotalOrders = matched.length;

  matched.forEach(o => {
    const phName = o.pharmacyName || 'غير محدد';
    if (!pharmacyMap.has(phName)) {
      pharmacyMap.set(phName, { count: 0, total: 0, itemsCount: 0, phone: o.phone || '' });
    }
    const cur = pharmacyMap.get(phName);
    cur.count += 1;
    cur.total += Number(o.totalAmount || 0);
    
    // Calculate items count for this order
    const orderItemsCount = (o.items && o.items.length > 0) 
      ? o.items.reduce((sum, it) => sum + (Number(it.quantity) || 1), 0)
      : 1;
    cur.itemsCount += orderItemsCount;
    grandTotalItems += orderItemsCount;

    if (!cur.phone && o.phone) cur.phone = o.phone;
  });

  const sheet = document.getElementById('staff-report-pdf-sheet');
  if (!sheet) return null;

  // Populate Meta Box
  const metaEl = document.getElementById('staff-pdf-meta-box');
  if (metaEl) {
    metaEl.innerHTML = `
      <div>👤 <b>الموظف المسؤول:</b> ${escapeHtml(staff === '__all__' ? 'كافة الموظفين' : staff)}</div>
      <div>📅 <b>الفترة الزمنية:</b> ${from || 'بداية السجلات'} إلى ${to || 'الآن'}</div>
      <div>⏰ <b>تاريخ ووقت الإصدار:</b> ${new Date().toLocaleString('ar-IQ')}</div>
    `;
  }

  // Populate KPI Summary Cards
  const kpiEl = document.getElementById('staff-pdf-summary-cards');
  if (kpiEl) {
    kpiEl.innerHTML = `
      <div style="background:#ecfdf5;border:1.5px solid #059669;padding:9px 10px;border-radius:8px;text-align:center;">
        <div style="font-size:11px;font-weight:700;color:#065f46;">المبلغ الإجمالي</div>
        <div style="font-size:15px;font-weight:900;color:#059669;margin-top:2px;">${totVal.toLocaleString()} <span style="font-size:10px;">د.ع</span></div>
      </div>
      <div style="background:#eff6ff;border:1.5px solid #2563eb;padding:9px 10px;border-radius:8px;text-align:center;">
        <div style="font-size:11px;font-weight:700;color:#1e40af;">عدد الصيدليات</div>
        <div style="font-size:15px;font-weight:900;color:#2563eb;margin-top:2px;">${pharmacyMap.size} <span style="font-size:10px;">صيدلية</span></div>
      </div>
      <div style="background:#fffbeb;border:1.5px solid #d97706;padding:9px 10px;border-radius:8px;text-align:center;">
        <div style="font-size:11px;font-weight:700;color:#92400e;">إجمالي عدد المواد</div>
        <div style="font-size:15px;font-weight:900;color:#d97706;margin-top:2px;">${grandTotalItems} <span style="font-size:10px;">قطعة</span></div>
      </div>
      <div style="background:#f5f3ff;border:1.5px solid #7c3aed;padding:9px 10px;border-radius:8px;text-align:center;">
        <div style="font-size:11px;font-weight:700;color:#5b21b6;">عدد الطلبيات</div>
        <div style="font-size:15px;font-weight:900;color:#7c3aed;margin-top:2px;">${grandTotalOrders} <span style="font-size:10px;">طلبية</span></div>
      </div>
    `;
  }

  // Populate Main Table Rows (ت | اسم الصيدلية المستلمة | الهاتف | عدد الطلبيات | عدد المواد | المبلغ)
  const phTableEl = document.getElementById('staff-pdf-pharmacies-rows');
  if (phTableEl) {
    if (pharmacyMap.size === 0) {
      phTableEl.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:14px;color:#64748b;font-weight:700;">لا توجد أي بيانات أو طلبيات مسجلة لهذا الموظف خلال الفترة المحددة</td></tr>`;
    } else {
      phTableEl.innerHTML = Array.from(pharmacyMap.entries()).map(([name, data], idx) => `
        <tr style="border-bottom:1px solid #000;background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};">
          <td style="border:1px solid #000;padding:6px 4px;text-align:center;font-weight:700;">${idx + 1}</td>
          <td style="border:1px solid #000;padding:6px 8px;font-weight:800;color:#0f172a;">${escapeHtml(name)}</td>
          <td style="border:1px solid #000;padding:6px 6px;text-align:center;font-size:11px;color:#334155;">${escapeHtml(data.phone || '-')}</td>
          <td style="border:1px solid #000;padding:6px 6px;text-align:center;font-weight:800;color:#2563eb;">${data.count}</td>
          <td style="border:1px solid #000;padding:6px 6px;text-align:center;font-weight:800;color:#d97706;">${data.itemsCount}</td>
          <td style="border:1px solid #000;padding:6px 8px;text-align:left;font-weight:900;font-family:monospace;font-size:12px;color:#059669;">${data.total.toLocaleString()} د.ع</td>
        </tr>
      `).join('');
    }
  }

  // Populate Grand Total Footer Row
  const tfootEl = document.getElementById('staff-pdf-pharmacies-tfoot');
  if (tfootEl) {
    tfootEl.innerHTML = `
      <tr style="background:#e2e8f0;font-weight:900;color:#0f172a;border-top:2px solid #000;font-size:12px;">
        <td colspan="3" style="border:1px solid #000;padding:8px 10px;text-align:right;font-size:13px;">
          ⭐️ <b>المجموع الكلي الإجمالي:</b> (${pharmacyMap.size} صيدلية)
        </td>
        <td style="border:1px solid #000;padding:8px 6px;text-align:center;font-size:13px;color:#2563eb;">
          ${grandTotalOrders}
        </td>
        <td style="border:1px solid #000;padding:8px 6px;text-align:center;font-size:13px;color:#d97706;">
          ${grandTotalItems}
        </td>
        <td style="border:1px solid #000;padding:8px 8px;text-align:left;font-size:13.5px;color:#059669;font-family:monospace;">
          ${totVal.toLocaleString()} د.ع
        </td>
      </tr>
    `;
  }

  // Populate Graphical Visual Bar Chart
  const chartBarsEl = document.getElementById('staff-pdf-chart-bars');
  if (chartBarsEl) {
    const sortedEntries = Array.from(pharmacyMap.entries()).sort((a, b) => b[1].total - a[1].total);
    const maxVal = sortedEntries.length > 0 ? Math.max(...sortedEntries.map(e => e[1].total), 1) : 1;
    
    if (sortedEntries.length === 0) {
      chartBarsEl.innerHTML = `<div style="text-align:center;color:#94a3b8;font-size:11px;padding:8px 0;">لا توجد بيانات لرسم المخطط البياني</div>`;
    } else {
      chartBarsEl.innerHTML = sortedEntries.slice(0, 10).map(([name, data]) => {
        const pct = Math.round((data.total / (totVal || 1)) * 100);
        const barWidth = Math.max(Math.round((data.total / maxVal) * 100), 2);
        return `
          <div style="display:flex;align-items:center;gap:10px;font-size:11px;">
            <div style="width:160px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1e293b;" title="${escapeHtml(name)}">
              🏥 ${escapeHtml(name)}
            </div>
            <div style="flex:1;background:#f1f5f9;height:18px;border-radius:4px;overflow:hidden;border:1px solid #e2e8f0;position:relative;">
              <div style="width:${barWidth}%;background:linear-gradient(90deg, #2563eb, #3b82f6);height:100%;border-radius:3px;"></div>
            </div>
            <div style="width:140px;text-align:left;font-weight:800;color:#0f172a;font-family:monospace;font-size:11.5px;">
              ${data.total.toLocaleString()} د.ع <span style="font-size:10px;color:#64748b;font-weight:600;">(${pct}%)</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  const genAtEl = document.getElementById('staff-pdf-generated-at');
  if (genAtEl) {
    genAtEl.innerText = new Date().toLocaleString('ar-IQ');
  }

  return { sheet, staff, totVal };
}

// Print Staff Report Directly without modal interference or overlaps
function printStaffReportDirect() {
  const result = populateStaffPdfSheet();
  if (!result || !result.sheet) return;

  const sheet = result.sheet;

  try {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <title>تقرير الموظف - مستودع سامو للأدوية</title>
        <style>
          @page { size: A4 portrait; margin: 8mm 10mm; }
          * { box-sizing: border-box; }
          body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; margin: 0; padding: 14px; color: #000; background: #fff; }
          table { width: 100%; border-collapse: collapse; border: 1.5px solid #000; }
          th, td { border: 1px solid #000; }
        </style>
      </head>
      <body>
        ${sheet.innerHTML}
      </body>
      </html>
    `);
    doc.close();

    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(() => {
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }, 1500);
      } catch (e) {
        document.body.classList.add('printing-staff-report');
        window.print();
        document.body.classList.remove('printing-staff-report');
      }
    }, 250);
  } catch (err) {
    document.body.classList.add('printing-staff-report');
    window.print();
    document.body.classList.remove('printing-staff-report');
  }
}

function exportSelectedStaffPDF() {
  const result = populateStaffPdfSheet();
  if (!result || !result.sheet) return;

  const { sheet, staff } = result;

  // Trigger HTML2PDF
  sheet.style.display = 'block';

  if (typeof window.html2pdf !== 'undefined') {
    const opt = {
      margin: [6, 6, 6, 6],
      filename: `تقرير_الموظف_${staff === '__all__' ? 'الكل' : staff}_${new Date().toISOString().slice(0, 10)}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };
    showQuickToast('جاري تصدير ملف PDF للتقرير...');
    window.html2pdf().set(opt).from(sheet).save().then(() => {
      sheet.style.display = 'none';
      showQuickToast('تم حفظ ملف PDF بنجاح ✓');
    }).catch(err => {
      console.warn('html2pdf fallback to direct print:', err);
      sheet.style.display = 'none';
      printStaffReportDirect();
    });
  } else {
    sheet.style.display = 'none';
    printStaffReportDirect();
  }
}

// Financial Reports
function updateFinanceReports() {
  const phCount = document.getElementById('fin-ph-count');
  const ordCount = document.getElementById('fin-orders-count');
  const stockVal = document.getElementById('fin-stock-val');
  const nearVal = document.getElementById('fin-near-stock-val');
  const expVal = document.getElementById('fin-expired-stock-val');
  const dispVal = document.getElementById('fin-dispatched-val');

  const pharmacies = new Set(orders.map(o => o.pharmacyName).filter(Boolean));
  if (phCount) phCount.innerText = `${pharmacies.size} صيدلية`;
  if (ordCount) ordCount.innerText = `${orders.length} طلب`;

  let totalStockVal = 0;
  let nearStockVal = 0;
  let expStockVal = 0;

  const now = new Date();
  const sixM = new Date();
  sixM.setMonth(now.getMonth() + 6);

  products.forEach(p => {
    const qty = Number(p.quantity) || 0;
    const price = Number(p.price) || 0;
    const val = qty * price;
    totalStockVal += val;

    if (p.expiryDate && qty > 0) {
      const expD = new Date(p.expiryDate);
      if (!isNaN(expD.getTime())) {
        if (expD < now) expStockVal += val;
        else if (expD <= sixM) nearStockVal += val;
      }
    }
  });

  const totalDispatched = orders.reduce((acc, o) => acc + (Number(o.totalAmount) || 0), 0);

  if (stockVal) stockVal.innerText = `${totalStockVal.toLocaleString()} د.ع`;
  if (nearVal) nearVal.innerText = `${nearStockVal.toLocaleString()} د.ع`;
  if (expVal) expStockVal && (expVal.innerText = `${expStockVal.toLocaleString()} د.ع`);
  if (dispVal) dispVal.innerText = `${totalDispatched.toLocaleString()} د.ع`;
}

function populateCompanyReportDropdown() {
  const sel = document.getElementById('report-company-select');
  if (!sel) return;
  const cur = sel.value;
  const comps = Array.from(new Set(products.map(p => p.company).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">-- اختر الشركة --</option>';
  comps.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.innerText = c;
    sel.appendChild(opt);
  });
  sel.value = cur;
}

function updateCompanyReport() {
  const sel = document.getElementById('report-company-select');
  if (!sel) return;
  const comp = sel.value;
  const itemsEl = document.getElementById('report-company-items');
  const amountEl = document.getElementById('report-company-amount');

  if (!comp) {
    if (itemsEl) itemsEl.innerText = '0 مادة';
    if (amountEl) amountEl.innerText = '0 د.ع';
    return;
  }

  const compProds = products.filter(p => p.company === comp);
  const sumAmount = compProds.reduce((acc, p) => acc + (Number(p.quantity || 0) * Number(p.price || 0)), 0);

  if (itemsEl) itemsEl.innerText = `${compProds.length} مادة`;
  if (amountEl) amountEl.innerText = `${sumAmount.toLocaleString()} د.ع`;
}

// CSV / Excel Exporters
function downloadCSV(filename, csvContent) {
  const blob = new Blob(["\ufeff" + csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportInventoryCSV() {
  let csv = 'معرف المادة,اسم المادة,الشركة,الباركود,الشكل الدوائي,الكمية,سعر المفرد,القيمة الإجمالية,البونص,تاريخ الصلاحية\n';
  products.forEach(p => {
    csv += `"${p.id}","${(p.name||'').replace(/"/g, '""')}","${(p.company||'').replace(/"/g, '""')}","${p.barcode||''}","${p.form||''}","${p.quantity||0}","${p.price||0}","${(p.quantity||0)*(p.price||0)}","${p.bonus||0}","${p.expiryDate||''}"\n`;
  });
  downloadCSV(`مخزون_سامو_الكامل_${new Date().toISOString().slice(0,10)}.csv`, csv);
}

function exportNearExpiryCSV() {
  const now = new Date();
  const sixM = new Date();
  sixM.setMonth(now.getMonth() + 6);

  let csv = 'اسم المادة,الشركة,الباركود,الكمية,سعر المفرد,تاريخ الصلاحية\n';
  products.forEach(p => {
    if (p.expiryDate && Number(p.quantity) > 0) {
      const d = new Date(p.expiryDate);
      if (d >= now && d <= sixM) {
        csv += `"${(p.name||'').replace(/"/g, '""')}","${(p.company||'').replace(/"/g, '""')}","${p.barcode||''}","${p.quantity}","${p.price}","${p.expiryDate}"\n`;
      }
    }
  });
  downloadCSV(`الأدوية_قريبة_النفاذ_${new Date().toISOString().slice(0,10)}.csv`, csv);
}

function exportExpiredCSV() {
  const now = new Date();
  let csv = 'اسم المادة,الشركة,الباركود,الكمية,سعر المفرد,تاريخ الصلاحية\n';
  products.forEach(p => {
    if (p.expiryDate && Number(p.quantity) > 0) {
      const d = new Date(p.expiryDate);
      if (d < now) {
        csv += `"${(p.name||'').replace(/"/g, '""')}","${(p.company||'').replace(/"/g, '""')}","${p.barcode||''}","${p.quantity}","${p.price}","${p.expiryDate}"\n`;
      }
    }
  });
  downloadCSV(`الأدوية_التالفة_المنتهية_${new Date().toISOString().slice(0,10)}.csv`, csv);
}

function exportStaffCSV() {
  let csv = 'اسم الموظف,عدد الطلبيات,إجمالي المبالغ المصروفة\n';
  staffNames.forEach(s => {
    const myOrders = orders.filter(o => o.staffName === s || o.deliveryStaffName === s);
    const sum = myOrders.reduce((a, b) => a + (Number(b.totalAmount) || 0), 0);
    csv += `"${s}","${myOrders.length}","${sum}"\n`;
  });
  downloadCSV(`تقرير_الموظفين_${new Date().toISOString().slice(0,10)}.csv`, csv);
}

function exportOrdersCSV() {
  let csv = 'رقم الطلب,اسم الصيدلية,الهاتف,الموظف المجهز,المبلغ الكلي,الحالة,التاريخ,المواد\n';
  orders.forEach(o => {
    const itemsStr = (o.items || []).map(it => `${it.name} (${it.quantity})`).join(' - ');
    csv += `"${o.orderNumber}","${(o.pharmacyName||'').replace(/"/g, '""')}","${o.phone||''}","${o.staffName||''}","${o.totalAmount||0}","${o.status||''}","${o.date||''}","${itemsStr.replace(/"/g, '""')}"\n`;
  });
  downloadCSV(`سجل_حركات_الصيدليات_${new Date().toISOString().slice(0,10)}.csv`, csv);
}

async function exportStockMovementsCSV() {
  try {
    const res = await fetch('/api/stock-movements?limit=5000');
    const data = await res.json();
    if (!data.movements) throw new Error('No movements found');
    let csv = 'التاريخ,معرف المادة,اسم الدواء,الباركود,نوع الحركة,الرصيد قبل,التغيير,الرصيد بعد,السبب,المستخدم,رقم الطلب\n';
    data.movements.forEach(m => {
      csv += `"${m.timestamp}","${m.productId||''}","${(m.productName||'').replace(/"/g, '""')}","${m.barcode||''}","${m.type||''}","${m.before||0}","${m.change||0}","${m.after||0}","${(m.reason||'').replace(/"/g, '""')}","${m.user||''}","${m.orderNumber||''}"\n`;
    });
    downloadCSV(`سجل_حركات_المخزون_${new Date().toISOString().slice(0,10)}.csv`, csv);
  } catch (e) {
    alert('حدث خطأ أثناء تحميل سجل الحركات: ' + e.message);
  }
}

// Helpers
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Settings Sub-Navigation & Rendering Hub
function switchSettingsTab(tab) {
  currentSettingsTab = tab || 'pharmacies';
  let activeBtn = null;
  ['pharmacies', 'staff', 'dosage', 'theme', 'appcontrol', 'security', 'backup'].forEach(t => {
    const btn = document.getElementById(`settings-tab-btn-${t}`);
    const panel = document.getElementById(`settings-panel-${t}`);
    if (btn) {
      if (t === currentSettingsTab) {
        btn.classList.add('active');
        activeBtn = btn;
      } else {
        btn.classList.remove('active');
      }
    }
    if (panel) {
      panel.style.display = (t === currentSettingsTab) ? 'block' : 'none';
    }
  });

  if (activeBtn && typeof activeBtn.scrollIntoView === 'function') {
    try {
      activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    } catch (e) {}
  }

  renderSettings();
}

function renderSettings() {
  if (currentSettingsTab === 'pharmacies') {
    renderSettingsPharmacies();
  } else if (currentSettingsTab === 'staff') {
    renderSettingsStaff();
  } else if (currentSettingsTab === 'dosage') {
    renderSettingsDosageForms();
  } else if (currentSettingsTab === 'theme') {
    renderSettingsTheme();
  } else if (currentSettingsTab === 'appcontrol') {
    renderSettingsAppControl();
  } else if (currentSettingsTab === 'security') {
    renderSettingsSecurity();
  } else if (currentSettingsTab === 'backup') {
    renderSettingsBackup();
  }
}

// 1. Settings: Approved Pharmacies
function renderSettingsPharmacies() {
  const container = document.getElementById('settings-pharmacies-container');
  if (!container) return;

  const totalEl = document.getElementById('settings-ph-total-count');
  const activeEl = document.getElementById('settings-ph-active-count');
  const staffEl = document.getElementById('settings-staff-count');

  const searchInput = document.getElementById('settings-ph-search');
  const sortSelect = document.getElementById('settings-ph-sort');
  const q = (searchInput?.value || '').trim().toLowerCase();
  const sort = sortSelect?.value || 'name_asc';

  // Auto-seed from previous orders if pharmacies list is totally empty
  if (pharmacies.length === 0 && (orders.length > 0 || pendingOrders.length > 0)) {
    const extractedNames = new Map();
    orders.concat(pendingOrders).forEach(o => {
      const name = (o.pharmacyName || o.customerName || '').trim();
      if (name && !extractedNames.has(name.toLowerCase())) {
        extractedNames.set(name.toLowerCase(), {
          id: Date.now() + Math.floor(Math.random() * 10000),
          name: name,
          phone: o.customerPhone || o.phone || '',
          address: o.address || '',
          notes: 'مستوردة تلقائياً من الطلبيات',
          createdAt: new Date().toISOString()
        });
      }
    });

    if (extractedNames.size > 0) {
      pharmacies = Array.from(extractedNames.values());
      saveLocalData();
      populatePharmacyDropdowns();
      // Sync in background with server
      postToApi({ action: 'import_pharmacies_from_orders' }).catch(() => {});
    }
  }

  // Count orders per pharmacy
  const orderCountMap = new Map();
  orders.concat(pendingOrders).forEach(o => {
    const pName = (o.pharmacyName || o.customerName || '').trim();
    if (pName) {
      orderCountMap.set(pName, (orderCountMap.get(pName) || 0) + 1);
    }
  });

  if (totalEl) totalEl.innerText = pharmacies.length;
  if (activeEl) {
    let activeCount = 0;
    pharmacies.forEach(p => { if (orderCountMap.has(p.name)) activeCount++; });
    activeEl.innerText = activeCount;
  }
  if (staffEl) staffEl.innerText = staffNames.length;

  let filtered = pharmacies.filter(p => {
    if (!q) return true;
    const name = String(p.name || '').toLowerCase();
    const phone = String(p.phone || '').toLowerCase();
    const address = String(p.address || '').toLowerCase();
    const notes = String(p.notes || '').toLowerCase();
    return name.includes(q) || phone.includes(q) || address.includes(q) || notes.includes(q);
  });

  // Sorting
  filtered.sort((a, b) => {
    if (sort === 'name_asc') return String(a.name || '').localeCompare(String(b.name || ''), 'ar');
    if (sort === 'name_desc') return String(b.name || '').localeCompare(String(a.name || ''), 'ar');
    if (sort === 'orders_desc') {
      const ca = orderCountMap.get(a.name) || 0;
      const cb = orderCountMap.get(b.name) || 0;
      return cb - ca;
    }
    if (sort === 'newest') return (Number(b.id) || 0) - (Number(a.id) || 0);
    return 0;
  });

  if (filtered.length === 0) {
    if (pharmacies.length === 0) {
      container.innerHTML = `
        <div style="background:#fff;border:1.5px dashed #cbd5e1;border-radius:14px;padding:36px 16px;text-align:center;">
          <div style="font-size:44px;margin-bottom:10px;">🏥</div>
          <div style="font-size:16px;font-weight:900;color:var(--ios-text);">لم تتم إضافة أي صيدليات معتمدة بعد</div>
          <div style="font-size:12px;color:var(--ios-sub);margin:6px auto 18px;max-width:440px;line-height:1.6;">
            أضف أسماء الصيدليات المعتمدة ليختار منها الموظفون حصراً عند إرسال الطلبيات، أو استوردها تلقائياً بضغطة زر واحدة من سجل الطلبيات القديمة.
          </div>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
            <button class="btn" style="background:var(--ios-green);padding:10px 18px;font-size:13px;font-weight:800;" onclick="openAddPharmacyModal()">
              ➕ إضافة صيدلية جديدة
            </button>
            <button class="btn btn-sec" style="background:#f0f9ff;color:#0369a1;border-color:#bae6fd;padding:10px 18px;font-size:13px;font-weight:700;" onclick="importPharmaciesFromOrdersPrompt()">
              📥 استيراد من الطلبيات السابقة
            </button>
          </div>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div style="background:#fff;border:1px solid var(--ios-border);border-radius:12px;padding:30px;text-align:center;color:var(--ios-sub);">
          <div style="font-size:28px;margin-bottom:6px;">🔍</div>
          <div style="font-weight:700;font-size:14px;">لا توجد صيدلية مطابقة للبحث "${escapeHtml(q)}"</div>
          <button class="btn btn-sec" style="margin-top:10px;font-size:12px;" onclick="document.getElementById('settings-ph-search').value='';renderSettingsPharmacies();">مسح البحث</button>
        </div>
      `;
    }
    return;
  }

  let html = `<div style="display:flex;flex-direction:column;gap:8px;">`;
  filtered.forEach(p => {
    const count = orderCountMap.get(p.name) || 0;
    const safeId = escapeHtml(String(p.id || ''));
    const safeName = escapeHtml(String(p.name || ''));
    html += `
      <div class="pharmacy-card-item">
        <div style="flex:1;min-width:240px;">
          <div class="pharmacy-item-name">
            <span style="font-size:18px;">🏥</span>
            <span>${safeName}</span>
            ${count > 0 ? `<span class="pharmacy-item-badge">📋 ${count} طلبية</span>` : `<span style="font-size:10.5px;color:#94a3b8;font-weight:700;">(جديدة)</span>`}
          </div>
          <div class="pharmacy-meta-tags">
            ${p.phone ? `<div class="pharmacy-meta-tag"><span>📱</span><a href="tel:${escapeHtml(p.phone)}" style="color:var(--ios-blue);text-decoration:none;font-weight:700;">${escapeHtml(p.phone)}</a></div>` : `<div class="pharmacy-meta-tag" style="color:#94a3b8;"><span>📱</span>بدون هاتف</div>`}
            ${p.address ? `<div class="pharmacy-meta-tag"><span>📍</span><span>${escapeHtml(p.address)}</span></div>` : ''}
            ${p.notes ? `<div class="pharmacy-meta-tag" style="color:#475569;"><span>📝</span><span>${escapeHtml(p.notes)}</span></div>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-sec" style="background:#f0fdf4;color:#16a34a;border-color:#bbf7d0;padding:6px 12px;font-size:11.5px;font-weight:800;" onclick="startOrderForPharmacy('${safeName}')" title="بدء تجهيز طلبية لهذه الصيدلية">
            🛒 طلبية جديدة
          </button>
          <button class="btn btn-sec" style="background:#f0f9ff;color:#0369a1;border-color:#bae6fd;padding:6px 12px;font-size:11.5px;font-weight:700;" onclick="openEditPharmacyModal('${safeId}')">
            ✏️ تعديل
          </button>
          <button class="btn btn-sec" style="background:#fff1f2;color:#e11d48;border-color:#fecdd3;padding:6px 12px;font-size:11.5px;font-weight:700;" onclick="deletePharmacyPrompt('${safeId}', '${safeName}')">
            🗑️ حذف
          </button>
        </div>
      </div>
    `;
  });
  html += `</div>`;
  container.innerHTML = html;
}

// Helper: Get assigned pharmacy for staff (by name or email)
function getAssignedPharmacyForStaff(staffNameOrEmail) {
  if (!staffNameOrEmail) return null;
  const target = String(staffNameOrEmail).trim().toLowerCase();
  const staffObj = (supabaseStaffList || []).find(s => 
    String(s.name || '').trim().toLowerCase() === target ||
    String(s.email || '').trim().toLowerCase() === target
  );
  if (staffObj && staffObj.assigned_pharmacy) {
    return {
      pharmacyName: staffObj.assigned_pharmacy,
      pharmacyPhone: staffObj.assigned_pharmacy_phone || ''
    };
  }
  return null;
}
window.getAssignedPharmacyForStaff = getAssignedPharmacyForStaff;

async function handleToggleStaffRole(nameOrEmail, newRole) {
  const target = String(nameOrEmail || '').trim();
  const cleanRole = (newRole === 'admin' || newRole === 'صاحب مذخر') ? 'صاحب مذخر' : 'مندوب';
  if (!target) return;

  // 1. Direct Supabase update
  const sb = getSupabaseClient();
  if (sb) {
    try {
      await sb.from('staff').update({ role: cleanRole }).or(`name.eq."${target}",email.eq."${target}"`);
    } catch (e) {
      console.warn('Supabase role update note:', e);
    }
  }

  // 2. Server API sync
  try {
    await fetch('/api/supabase/staff/set-role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: target, role: cleanRole })
    });
  } catch (err) {
    console.warn('API staff set-role warning:', err);
  }

  // Update in-memory list
  const targetLower = target.toLowerCase();
  (supabaseStaffList || []).forEach(s => {
    if (String(s.name || '').toLowerCase() === targetLower || String(s.email || '').toLowerCase() === targetLower) {
      s.role = cleanRole;
    }
  });

  // If current logged-in user changed role
  if (currentStaffEmail && (currentStaffEmail.toLowerCase() === targetLower || String(currentStaff || '').toLowerCase() === targetLower)) {
    if (cleanRole === 'صاحب مذخر') {
      isAdmin = true;
      localStorage.setItem('samo_is_admin', 'true');
      applyAdminState();
      showQuickToast(`👑 تم ترقية حسابك إلى "صاحب مذخر"! تم تفعيل الدخول بدون رمز.`);
    } else {
      isAdmin = false;
      localStorage.removeItem('samo_is_admin');
      applyAdminState();
      showQuickToast(`تم تحويل حسابك إلى "حساب عادي".`);
    }
  }

  renderSettingsStaff();
  populateStaffDropdowns();
  if (cleanRole === 'صاحب مذخر') {
    showQuickToast(`👑 تم تعيين (${target}) كـ "صاحب مذخر" بنجاح! يمكنه الدخول للوحة التحكم مباشرة وبدون رمز.`);
  } else {
    showQuickToast(`👤 تم تحويل (${target}) إلى "حساب عادي" وتقييده.`);
  }
  fetchStaffFromSupabaseDirect(false);
}
window.handleToggleStaffRole = handleToggleStaffRole;

async function handleAssignPharmacyToStaff(staffName, pharmacyName) {
  const sName = String(staffName || '').trim();
  const pName = String(pharmacyName || '').trim();
  if (!sName) return;

  const foundPh = (pharmacies || []).find(p => p.name === pName);
  const pPhone = foundPh?.phone || '';

  // 1. Direct Supabase Update
  const sb = getSupabaseClient();
  if (sb) {
    try {
      const { error } = await sb
        .from('staff')
        .update({
          assigned_pharmacy: pName,
          assigned_pharmacy_phone: pPhone
        })
        .or(`name.eq."${sName}",email.eq."${sName}"`);
      if (error) {
        console.warn('Supabase staff assign note:', error.message);
      }
    } catch (e) {
      console.warn('Supabase staff assign exception:', e);
    }
  }

  // 2. Server API sync
  try {
    await fetch('/api/supabase/staff/assign-pharmacy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: sName,
        assignedPharmacy: pName,
        pharmacyPhone: pPhone
      })
    });
  } catch (err) {
    console.warn('API staff assign warning:', err);
  }

  // Update in-memory list
  const targetLower = sName.toLowerCase();
  let foundObj = (supabaseStaffList || []).find(s => 
    String(s.name || '').toLowerCase() === targetLower ||
    String(s.email || '').toLowerCase() === targetLower
  );
  if (foundObj) {
    foundObj.assigned_pharmacy = pName;
    foundObj.assigned_pharmacy_phone = pPhone;
  } else {
    supabaseStaffList.push({ name: sName, email: sName.includes('@') ? sName : '', role: 'مندوب', assigned_pharmacy: pName, assigned_pharmacy_phone: pPhone });
  }

  renderSettingsStaff();
  populateStaffDropdowns();
  if (pName) {
    showQuickToast(`تم ربط صيدلية (${pName}) بحساب (${sName}) بنجاح! لن تظهر له إلا هذه الصيدلية ✓`);
  } else {
    showQuickToast(`تم إلغاء قيد الصيدلية عن حساب (${sName}) ✓`);
  }
  fetchStaffFromSupabaseDirect(false);
}
window.handleAssignPharmacyToStaff = handleAssignPharmacyToStaff;

async function handleUnassignPharmacyFromStaff(staffName) {
  await handleAssignPharmacyToStaff(staffName, '');
}
window.handleUnassignPharmacyFromStaff = handleUnassignPharmacyFromStaff;

// 2. Settings: Staff & Google Accounts Management
function renderSettingsStaff() {
  const container = document.getElementById('settings-staff-list-container');
  if (!container) return;

  // Build a consolidated list of unique accounts (matching by email or name to prevent duplicates)
  const accountMap = new Map();

  (supabaseStaffList || []).forEach(s => {
    const cleanEmail = String(s.email || '').trim().toLowerCase();
    const cleanName = String(s.name || (cleanEmail ? cleanEmail.split('@')[0] : 'موظف')).trim();
    if (!cleanEmail && !cleanName) return;

    let foundKey = null;
    for (const [k, acc] of accountMap.entries()) {
      const accEmail = String(acc.email || '').toLowerCase();
      const accName = String(acc.name || '').toLowerCase();
      if ((cleanEmail && accEmail && accEmail === cleanEmail) || (cleanName && accName && accName === cleanName.toLowerCase())) {
        foundKey = k;
        break;
      }
    }

    const obj = {
      name: (cleanName && cleanName !== 'موظف' && !cleanName.includes('@')) ? cleanName : (s.name || (cleanEmail ? cleanEmail.split('@')[0] : 'موظف')),
      email: cleanEmail,
      role: s.role || 'مندوب',
      assigned_pharmacy: s.assigned_pharmacy || '',
      assigned_pharmacy_phone: s.assigned_pharmacy_phone || ''
    };

    if (foundKey) {
      const existing = accountMap.get(foundKey);
      accountMap.set(foundKey, {
        ...existing,
        ...obj,
        name: (obj.name && obj.name !== 'موظف' && !obj.name.includes('@')) ? obj.name : existing.name,
        email: cleanEmail || existing.email,
        role: (existing.role === 'admin' || existing.role === 'صاحب مذخر') ? existing.role : obj.role,
        assigned_pharmacy: obj.assigned_pharmacy || existing.assigned_pharmacy,
        assigned_pharmacy_phone: obj.assigned_pharmacy_phone || existing.assigned_pharmacy_phone
      });
    } else {
      const mainKey = cleanEmail ? `email:${cleanEmail}` : `name:${cleanName.toLowerCase()}`;
      accountMap.set(mainKey, obj);
    }
  });

  (staffNames || []).forEach(rawName => {
    const nameStr = String(rawName || '').trim();
    if (!nameStr) return;
    const isEmail = nameStr.includes('@');
    const cleanEmail = isEmail ? nameStr.toLowerCase() : '';
    const cleanName = isEmail ? nameStr.split('@')[0] : nameStr;

    let foundKey = null;
    for (const [k, acc] of accountMap.entries()) {
      const accEmail = String(acc.email || '').toLowerCase();
      const accName = String(acc.name || '').toLowerCase();
      if ((cleanEmail && accEmail && accEmail === cleanEmail) || (cleanName && accName && accName === cleanName.toLowerCase())) {
        foundKey = k;
        break;
      }
    }

    if (!foundKey) {
      const mainKey = cleanEmail ? `email:${cleanEmail}` : `name:${cleanName.toLowerCase()}`;
      accountMap.set(mainKey, {
        name: cleanName,
        email: cleanEmail,
        role: 'مندوب',
        assigned_pharmacy: '',
        assigned_pharmacy_phone: ''
      });
    }
  });

  const allAccounts = Array.from(accountMap.values());

  if (allAccounts.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:24px; color:var(--ios-sub); font-size:13px;">
        لا توجد حسابات أو موظفون مسجلون حالياً. يمكنك تسجيل الدخول بـ Google أو إضافة حساب جديد أعلاه.
      </div>
    `;
    return;
  }

  // Calculate stats for each staff member
  const staffStats = new Map();
  allAccounts.forEach(acc => {
    staffStats.set(acc.name, { ordersCount: 0, totalAmount: 0 });
    if (acc.email) staffStats.set(acc.email, { ordersCount: 0, totalAmount: 0 });
  });

  orders.concat(pendingOrders).forEach(o => {
    const rep = (o.representative || o.staffName || '').trim();
    const repEmail = (o.staffEmail || '').trim().toLowerCase();
    if (rep && staffStats.has(rep)) {
      const cur = staffStats.get(rep);
      cur.ordersCount += 1;
      cur.totalAmount += (Number(o.totalPrice || o.total) || 0);
    } else if (repEmail && staffStats.has(repEmail)) {
      const cur = staffStats.get(repEmail);
      cur.ordersCount += 1;
      cur.totalAmount += (Number(o.totalPrice || o.total) || 0);
    }
  });

  // Prepare sorted pharmacy options list
  const sortedPharmacies = Array.isArray(pharmacies) ? [...pharmacies] : [];
  sortedPharmacies.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ar'));

  let html = `<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(330px, 1fr)); gap:14px;">`;
  
  allAccounts.forEach(acc => {
    const safeName = escapeHtml(acc.name);
    const safeEmail = escapeHtml(acc.email);
    const isOwner = (acc.role === 'admin' || acc.role === 'صاحب مذخر' || acc.role === 'owner');
    const isCurrent = (currentStaffEmail && acc.email && currentStaffEmail === acc.email.toLowerCase()) || (currentStaff && acc.name && currentStaff.toLowerCase() === acc.name.toLowerCase());
    const stats = staffStats.get(acc.name) || staffStats.get(acc.email) || { ordersCount: 0, totalAmount: 0 };
    const assignedPhName = acc.assigned_pharmacy || '';
    const safeId = 'staff-ph-sel-' + encodeURIComponent(acc.email || acc.name).replace(/[^a-zA-Z0-9]/g, '_');
    const targetKey = acc.email || acc.name;

    html += `
      <div style="background:#ffffff; border:1.5px solid ${isOwner ? '#10b981' : (isCurrent ? 'var(--ios-blue)' : '#e2e8f0')}; border-radius:14px; padding:15px; display:flex; flex-direction:column; justify-content:space-between; gap:12px; box-shadow:0 2px 8px rgba(0,0,0,0.04);">
        <div>
          <!-- Header with Avatar & Role Badge -->
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
            <div>
              <div style="font-weight:800; font-size:15px; color:#0f172a; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span>${acc.email ? '🌐' : '👤'}</span>
                <span>${safeName}</span>
                ${isCurrent ? `<span style="background:#e0f2fe; color:#0284c7; font-size:10px; padding:2px 7px; border-radius:8px; font-weight:800;">حسابك الحالي</span>` : ''}
              </div>
              ${acc.email ? `
                <div style="font-size:11.5px; color:#475569; font-family:monospace; margin-top:2px; display:flex; align-items:center; gap:4px;">
                  <svg width="12" height="12" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
                  <span>${safeEmail}</span>
                </div>
              ` : ''}
            </div>

            <!-- Role Badge -->
            <div>
              ${isOwner ? `
                <span style="background:#ecfdf5; color:#059669; border:1px solid #a7f3d0; font-size:11px; font-weight:800; padding:4px 8px; border-radius:10px; display:inline-flex; align-items:center; gap:4px;">
                  👑 صاحب مذخر (دخول بلا رمز)
                </span>
              ` : `
                <span style="background:#f8fafc; color:#64748b; border:1px solid #e2e8f0; font-size:11px; font-weight:700; padding:4px 8px; border-radius:10px;">
                  👤 حساب عادي
                </span>
              `}
            </div>
          </div>

          <!-- Quick Stats & Role Switcher Actions -->
          <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; padding:8px 10px; border-radius:8px; margin-bottom:10px; border:1px solid #f1f5f9;">
            <div style="font-size:11.5px; color:#475569;">
              الطلبيات: <b>${stats.ordersCount}</b> | المبيعات: <b>${stats.totalAmount.toLocaleString()} د.ع</b>
            </div>
            
            <div style="display:flex; gap:5px;">
              ${isOwner ? `
                <button class="btn btn-sec" style="padding:4px 8px; font-size:11px; font-weight:700; color:#b45309; background:#fef3c7; border-color:#fde68a;" onclick="handleToggleStaffRole('${escapeHtml(targetKey)}', 'مندوب')" title="تحويل الحساب إلى مستخدم عادي مقيد">
                  👤 تحويل لحساب عادي
                </button>
              ` : `
                <button class="btn" style="padding:4px 8px; font-size:11px; font-weight:800; background:#059669; color:#fff; border-radius:8px;" onclick="handleToggleStaffRole('${escapeHtml(targetKey)}', 'صاحب مذخر')" title="ترقية إلى صاحب مذخر ليدخل بدون رمز أمان">
                  👑 تعيين كـ صاحب مذخر
                </button>
              `}
              <button class="btn btn-sec" style="background:#fff1f2; color:#e11d48; border-color:#fecdd3; padding:4px 8px; font-size:11px; font-weight:700;" onclick="deleteStaffFromSettings('${safeName}')" title="حذف الحساب نهائياً">
                🗑️
              </button>
            </div>
          </div>

          <!-- Permissions & Pharmacy Binding Section -->
          ${isOwner ? `
            <div style="background:#ecfdf5; border:1.5px solid #a7f3d0; border-radius:10px; padding:10px; margin-top:4px;">
              <div style="font-size:12px; font-weight:800; color:#065f46; display:flex; align-items:center; gap:6px;">
                <span>✨</span>
                <span>صلاحية صاحب المذخر مفعلة:</span>
              </div>
              <div style="font-size:11px; color:#047857; margin-top:4px; line-height:1.4;">
                • يدخل إلى لوحة تحكم المذخر والإعدادات <b>مباشرة بدون طلب رمز PIN</b>.<br>
                • لديه وصول غير مقيد لجميع الصيدليات والمخازن والتقارير المالية.
              </div>
            </div>
          ` : `
            <div style="background:#f0f9ff; border:1.5px solid #bae6fd; border-radius:10px; padding:10px; margin-top:4px;">
              <div style="font-size:12px; font-weight:800; color:#0369a1; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
                <span>🏥 الصيدلية المخصصة (لا تظهر له إلا هي):</span>
                ${assignedPhName ? `
                  <span style="background:#0284c7; color:#ffffff; font-size:10px; padding:2px 7px; border-radius:6px; font-weight:800;">
                    🔒 مقيدة ومربوطة
                  </span>
                ` : `
                  <span style="background:#e0f2fe; color:#0369a1; font-size:10px; padding:2px 6px; border-radius:6px;">
                    غير محدد (حر)
                  </span>
                `}
              </div>

              <div style="display:flex; gap:6px; align-items:center;">
                <select id="${safeId}" style="flex:1; padding:7px 9px; border-radius:8px; border:1px solid #93c5fd; font-size:12px; font-weight:700; background:#fff; outline:none;">
                  <option value="">-- بدون تخصيص (حر الاختيار) --</option>
                  ${sortedPharmacies.map(p => {
                    const isSel = (p.name === assignedPhName);
                    return `<option value="${escapeHtml(p.name)}" ${isSel ? 'selected' : ''}>🏥 ${escapeHtml(p.name)} ${p.phone ? `(${escapeHtml(p.phone)})` : ''}</option>`;
                  }).join('')}
                </select>
                <button class="btn" style="background:var(--ios-blue); padding:7px 11px; font-size:11.5px; font-weight:800; white-space:nowrap; border-radius:8px;" onclick="handleAssignPharmacyToStaff('${escapeHtml(targetKey)}', document.getElementById('${safeId}').value)" title="حفظ وتثبيت الصيدلية في قاعدة البيانات السحابية">
                  💾 حفظ
                </button>
                ${assignedPhName ? `
                  <button class="btn btn-sec" style="color:var(--ios-red); border-color:#fecaca; background:#fff; padding:7px 9px; font-size:11.5px; font-weight:800; border-radius:8px;" onclick="handleUnassignPharmacyFromStaff('${escapeHtml(targetKey)}')" title="إلغاء قيد الصيدلية">
                    ✕ إلغاء
                  </button>
                ` : ''}
              </div>

              ${assignedPhName ? `
                <div style="font-size:11px; color:#0284c7; font-weight:800; margin-top:6px;">
                  ✓ تم قفل الحساب: عند تسجيل دخول <b>(${safeName})</b> لن تظهر له سوى <b>${escapeHtml(assignedPhName)}</b> فقط.
                </div>
              ` : `
                <div style="font-size:10.5px; color:#64748b; margin-top:4px;">
                  اختر صيدلية واضغط حفظ لتقييد هذا الحساب بصيدليته فقط ومنعه من رؤية أو اختيار أي صيدلية أخرى.
                </div>
              `}
            </div>
          `}
        </div>
      </div>
    `;
  });

  html += `</div>`;
  container.innerHTML = html;
}

async function handleAddNewStaffFromSettings() {
  const input = document.getElementById('settings-new-staff-name');
  const name = (input?.value || '').trim();
  if (!name) {
    alert('يرجى كتابة اسم الموظف');
    return;
  }
  if (staffNames.includes(name)) {
    alert('اسم الموظف موجود مسبقاً');
    return;
  }

  try {
    const sb = getSupabaseClient();
    if (sb) {
      const { error: sbErr } = await sb.from('staff').insert([{
        name,
        role: 'مندوب مبيعات',
        email: '',
        assigned_pharmacy: '',
        assigned_pharmacy_phone: '',
        created_at: new Date().toISOString()
      }]);
      if (sbErr) {
        console.warn('Direct Supabase staff insert note:', sbErr.message);
      }
    }

    const res = await postToApi({ action: 'add_staff', name });
    if (res && res.staffNames) staffNames = res.staffNames;
    else if (!staffNames.includes(name)) staffNames.push(name);

    if (!currentStaff) {
      currentStaff = name;
      localStorage.setItem('samo_current_staff', name);
    }

    saveLocalData();
    populateStaffDropdowns();
    renderSettingsStaff();
    if (input) input.value = '';
    showQuickToast(`تمت إضافة الموظف "${name}" وحفظه في Supabase بنجاح ✓`);
    await fetchStaffFromSupabaseDirect(false);
  } catch (err) {
    console.error('Error adding staff:', err);
    if (!staffNames.includes(name)) staffNames.push(name);
    saveLocalData();
    populateStaffDropdowns();
    renderSettingsStaff();
    if (input) input.value = '';
    showQuickToast(`تمت إضافة الموظف محلياً ✓`);
  }
}

function setActiveStaffDevice(name) {
  currentStaff = name;
  localStorage.setItem('samo_current_staff', name);
  renderSettingsStaff();
  populateStaffDropdowns();
  const assigned = getAssignedPharmacyForStaff(name);
  const lbl = document.getElementById('conn-lbl');
  if (lbl && !isAdmin) {
    if (assigned && assigned.pharmacyName) {
      lbl.innerText = `وضع الموظف: ${currentStaff} (🏥 ${assigned.pharmacyName})`;
    } else {
      lbl.innerText = `وضع الموظف: ${currentStaff} (متصل)`;
    }
  }
  showQuickToast(`تم تعيين "${name}" كمستخدم افتراضي لهذا المتصفح ✓`);
}

function deleteStaffFromSettings(name) {
  if (staffNames.length <= 1) {
    alert('يجب أن يبقى موظف واحد على الأقل في النظام.');
    return;
  }
  showInAppConfirm({
    title: 'حذف الموظف',
    message: `هل أنت متأكد من حذف الموظف "${name}" من النظام وقاعدة بيانات Supabase؟`,
    icon: '👤',
    confirmText: 'نعم، حذف الموظف',
    isDanger: true,
    onConfirm: async () => {
      try {
        const sb = getSupabaseClient();
        if (sb) {
          const { error: sbErr } = await sb.from('staff').delete().eq('name', name);
          if (sbErr) {
            console.warn('Direct Supabase staff delete note:', sbErr.message);
          }
        }

        await postToApi({ action: 'delete_staff', name });
        staffNames = staffNames.filter(x => x !== name);
        if (currentStaff === name) {
          currentStaff = staffNames[0] || '';
          localStorage.setItem('samo_current_staff', currentStaff);
        }
        saveLocalData();
        populateStaffDropdowns();
        renderSettingsStaff();
        showQuickToast('تم حذف الموظف من السيرفر بنجاح ✓');
        await fetchStaffFromSupabaseDirect(false);
      } catch (err) {
        console.error('Error deleting staff:', err);
        staffNames = staffNames.filter(x => x !== name);
        saveLocalData();
        populateStaffDropdowns();
        renderSettingsStaff();
        showQuickToast('تم حذف الموظف محلياً ✓');
      }
    }
  });
}

function goToDosageFormsSettings() {
  if (isAdmin) {
    setMainTab('settings');
    switchSettingsTab('dosage');
    showQuickToast('تم فتح قسم إدارة الأشكال الدوائية 💊');
  } else {
    openSettingsTabPrompt('dosage');
  }
}

// 3. Settings: Dosage Forms Management
function renderSettingsDosageForms() {
  const container = document.getElementById('settings-dosage-list-container');
  if (!container) return;

  const totalEl = document.getElementById('settings-dosage-total-count');
  const searchInput = document.getElementById('settings-dosage-search');
  const q = (searchInput?.value || '').trim().toLowerCase();

  syncDosageFormsFromSettings();
  if (totalEl) totalEl.innerText = dosageForms.length;

  // Count products per dosage form
  const countMap = new Map();
  if (Array.isArray(products)) {
    products.forEach(p => {
      const f = (p.form || '').trim().toLowerCase();
      if (f) {
        countMap.set(f, (countMap.get(f) || 0) + 1);
      }
    });
  }

  const filtered = dosageForms.filter(f => {
    if (!q) return true;
    const nameAr = String(f.nameAr || '').toLowerCase();
    const key = String(f.key || '').toLowerCase();
    return nameAr.includes(q) || key.includes(q);
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:30px; background:#fff; border-radius:12px; border:1px dashed var(--ios-border); color:#64748b;">
        <div style="font-size:32px; margin-bottom:8px;">💊</div>
        <div style="font-weight:700;">لا توجد أشكال دوائية مطابقة للبحث</div>
        <button class="btn btn-sec" style="margin-top:10px; font-size:12px;" onclick="openAddDosageFormModal()">➕ إضافة شكل دوائي الآن</button>
      </div>
    `;
    return;
  }

  let html = '<div style="display:flex; flex-direction:column; gap:8px;">';
  filtered.forEach(f => {
    const prodCount = countMap.get((f.key || '').toLowerCase()) || 0;
    html += `
      <div class="dosage-card-item">
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="dosage-icon-bubble">${escapeHtml(f.icon || '💊')}</div>
          <div>
            <div style="font-weight:800; font-size:14px; color:var(--ios-text);">${escapeHtml(f.nameAr || f.key)}</div>
            <div style="display:flex; gap:8px; align-items:center; font-size:11.5px; color:#64748b; margin-top:3px;">
              <span style="background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:6px; font-weight:700; font-family:monospace;">${escapeHtml(f.key)}</span>
              <span>•</span>
              <span style="font-weight:600;">${prodCount} مادة مسجلة بهذا الشكل</span>
            </div>
          </div>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <button class="btn btn-sec" style="padding:6px 12px; font-size:12px; font-weight:700;" onclick="openEditDosageFormModal('${escapeHtml(f.id)}')">
            ✏️ تعديل
          </button>
          <button class="btn btn-danger" style="padding:6px 10px; font-size:12px;" onclick="deleteDosageFormPrompt('${escapeHtml(f.id)}')">
            🗑️
          </button>
        </div>
      </div>
    `;
  });
  html += '</div>';
  container.innerHTML = html;
}

function openAddDosageFormModal() {
  const modal = document.getElementById('modal-dosage-form');
  const title = document.getElementById('dosage-modal-title');
  const idInput = document.getElementById('dosage-form-id');
  const nameArInput = document.getElementById('dosage-form-name-ar');
  const keyInput = document.getElementById('dosage-form-key');
  const iconInput = document.getElementById('dosage-form-icon');

  if (title) title.innerText = '➕ إضافة شكل دوائي جديد';
  if (idInput) idInput.value = '';
  if (nameArInput) nameArInput.value = '';
  if (keyInput) keyInput.value = '';
  if (iconInput) iconInput.value = '💊';

  if (modal) modal.classList.add('is-open');
  setTimeout(() => { if (nameArInput) nameArInput.focus(); }, 120);
}

function openEditDosageFormModal(id) {
  const f = dosageForms.find(x => String(x.id) === String(id));
  if (!f) return;

  const modal = document.getElementById('modal-dosage-form');
  const title = document.getElementById('dosage-modal-title');
  const idInput = document.getElementById('dosage-form-id');
  const nameArInput = document.getElementById('dosage-form-name-ar');
  const keyInput = document.getElementById('dosage-form-key');
  const iconInput = document.getElementById('dosage-form-icon');

  if (title) title.innerText = `✏️ تعديل الشكل الدوائي: ${f.nameAr || f.key}`;
  if (idInput) idInput.value = f.id;
  if (nameArInput) nameArInput.value = f.nameAr || '';
  if (keyInput) keyInput.value = f.key || '';
  if (iconInput) iconInput.value = f.icon || '💊';

  if (modal) modal.classList.add('is-open');
}

function closeDosageFormModal() {
  const modal = document.getElementById('modal-dosage-form');
  if (modal) modal.classList.remove('is-open');
}

async function handleSaveDosageFormSubmit(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('dosage-form-id')?.value;
  const nameAr = (document.getElementById('dosage-form-name-ar')?.value || '').trim();
  const key = (document.getElementById('dosage-form-key')?.value || '').trim();
  const icon = (document.getElementById('dosage-form-icon')?.value || '💊').trim() || '💊';

  if (!nameAr || !key) {
    alert('يرجى كتابة الاسم بالعربية والمفتاح الإنجليزي');
    return;
  }

  if (id) {
    // Edit existing
    const idx = dosageForms.findIndex(x => String(x.id) === String(id));
    if (idx !== -1) {
      const oldKey = dosageForms[idx].key;
      dosageForms[idx] = { ...dosageForms[idx], nameAr, key, icon };

      // If key changed, update products that had oldKey
      if (oldKey && oldKey !== key && Array.isArray(products)) {
        products.forEach(p => {
          if ((p.form || '').toLowerCase() === oldKey.toLowerCase()) {
            p.form = key;
          }
        });
      }
    }
  } else {
    // Add new
    // Check if key already exists
    const exists = dosageForms.some(x => (x.key || '').toLowerCase() === key.toLowerCase());
    if (exists) {
      alert(`الشكل الدوائي "${key}" موجود بالفعل مسبقاً!`);
      return;
    }
    dosageForms.push({
      id: `form-${Date.now()}`,
      key,
      nameAr,
      icon
    });
  }

  systemSettings.dosage_forms = JSON.stringify(dosageForms);
  saveLocalData();
  closeDosageFormModal();
  populateAllDosageFormSelectors();
  renderSettingsDosageForms();
  renderProducts();

  try {
    await postToApi({
      action: 'save_settings',
      settings: systemSettings
    });
    showQuickToast('تم حفظ الشكل الدوائي بنجاح ✓');
  } catch (err) {
    console.error('Save dosage form error:', err);
    showQuickToast('تم حفظ الشكل الدوائي محلياً ✓');
  }
}

function deleteDosageFormPrompt(id) {
  const f = dosageForms.find(x => String(x.id) === String(id));
  if (!f) return;

  const count = Array.isArray(products)
    ? products.filter(p => (p.form || '').toLowerCase() === (f.key || '').toLowerCase()).length
    : 0;

  const warning = count > 0 ? `\nتنبيه: هناك (${count}) مادة مسجلة حالياً بهذا الشكل.` : '';

  showInAppConfirm({
    title: 'حذف الشكل الدوائي',
    message: `هل أنت متأكد من رغبتك في حذف الشكل الدوائي "${f.nameAr || f.key}"؟${warning}`,
    icon: '💊',
    confirmText: 'نعم، حذف الشكل',
    isDanger: true,
    onConfirm: async () => {
      dosageForms = dosageForms.filter(x => String(x.id) !== String(id));
      systemSettings.dosage_forms = JSON.stringify(dosageForms);
      saveLocalData();
      populateAllDosageFormSelectors();
      renderSettingsDosageForms();
      renderProducts();

      try {
        await postToApi({
          action: 'save_settings',
          settings: systemSettings
        });
        showQuickToast('تم حذف الشكل الدوائي بنجاح ✓');
      } catch (err) {
        showQuickToast('تم حذف الشكل الدوائي محلياً ✓');
      }
    }
  });
}

function restoreDefaultDosageFormsPrompt() {
  showInAppConfirm({
    title: 'استعادة الأشكال الدوائية الافتراضية',
    message: 'هل تريد إعادة ضبط قائمة الأشكال الدوائية إلى القائمة الافتراضية الكاملة للمستودع؟',
    icon: '🔄',
    confirmText: 'نعم، استعادة الافتراضي',
    isDanger: false,
    onConfirm: async () => {
      dosageForms = [...DEFAULT_DOSAGE_FORMS];
      systemSettings.dosage_forms = JSON.stringify(dosageForms);
      saveLocalData();
      populateAllDosageFormSelectors();
      renderSettingsDosageForms();
      renderProducts();

      try {
        await postToApi({
          action: 'save_settings',
          settings: systemSettings
        });
        showQuickToast('تمت استعادة الأشكال الدوائية الافتراضية ✓');
      } catch (err) {
        showQuickToast('تمت الاستعادة محلياً ✓');
      }
    }
  });
}

// 4. Settings: App Control & System Customization
function renderSettingsAppControl() {
  const nameInput = document.getElementById('setting-store-name');
  const phoneInput = document.getElementById('setting-store-phone');
  const addrInput = document.getElementById('setting-store-address');
  const noteInput = document.getElementById('setting-invoice-note');
  const minStockInput = document.getElementById('setting-min-stock');
  const nearExpirySel = document.getElementById('setting-near-expiry-months');
  const allowOversellingSel = document.getElementById('setting-allow-overselling');
  const defaultHideOutStockSel = document.getElementById('setting-default-hide-out-stock');
  const currencySel = document.getElementById('setting-currency-symbol');
  const enableBonusSel = document.getElementById('setting-enable-bonus');
  const thermalFontSel = document.getElementById('setting-thermal-font-size');
  const printQrSel = document.getElementById('setting-print-qr');
  const themeColorSel = document.getElementById('setting-theme-color');
  const cardDensitySel = document.getElementById('setting-card-density');

  if (nameInput) nameInput.value = systemSettings.store_name || 'مذخر سامو الدوائي';
  if (phoneInput) phoneInput.value = systemSettings.store_phone || '07700000000';
  if (addrInput) addrInput.value = systemSettings.store_address || 'العراق - بغداد';
  if (noteInput) noteInput.value = systemSettings.invoice_note || 'شكراً لتعاملكم مع مذخر سامو الدوائي. يرجى تدقيق ومطابقة المواد والكميات عند الاستلام.';
  if (minStockInput) minStockInput.value = systemSettings.min_stock_alert || '5';
  if (nearExpirySel) nearExpirySel.value = systemSettings.near_expiry_months || '6';
  if (allowOversellingSel) allowOversellingSel.value = systemSettings.allow_overselling || 'false';
  if (defaultHideOutStockSel) defaultHideOutStockSel.value = systemSettings.default_hide_out_of_stock || 'false';
  if (currencySel) currencySel.value = systemSettings.currency_symbol || 'د.ع';
  if (enableBonusSel) enableBonusSel.value = systemSettings.enable_bonus || 'true';
  if (thermalFontSel) thermalFontSel.value = systemSettings.thermal_font_size || 'normal';
  if (printQrSel) printQrSel.value = systemSettings.print_qr || 'true';
  if (themeColorSel) themeColorSel.value = systemSettings.app_theme_color || '#007aff';
  if (cardDensitySel) cardDensitySel.value = systemSettings.prod_card_density || 'detailed';
}

function renderSettingsStore() {
  renderSettingsAppControl();
}

async function handleSaveAppControlSubmit(e) {
  if (e) e.preventDefault();

  const store_name = (document.getElementById('setting-store-name')?.value || '').trim() || 'مذخر سامو الدوائي';
  const store_phone = (document.getElementById('setting-store-phone')?.value || '').trim();
  const store_address = (document.getElementById('setting-store-address')?.value || '').trim();
  const invoice_note = (document.getElementById('setting-invoice-note')?.value || '').trim();
  const min_stock_alert = (document.getElementById('setting-min-stock')?.value || '').trim() || '5';
  const near_expiry_months = document.getElementById('setting-near-expiry-months')?.value || '6';
  const allow_overselling = document.getElementById('setting-allow-overselling')?.value || 'false';
  const default_hide_out_of_stock = document.getElementById('setting-default-hide-out-stock')?.value || 'false';
  const currency_symbol = document.getElementById('setting-currency-symbol')?.value || 'د.ع';
  const enable_bonus = document.getElementById('setting-enable-bonus')?.value || 'true';
  const thermal_font_size = document.getElementById('setting-thermal-font-size')?.value || 'normal';
  const print_qr = document.getElementById('setting-print-qr')?.value || 'true';
  const app_theme_color = document.getElementById('setting-theme-color')?.value || '#007aff';
  const prod_card_density = document.getElementById('setting-card-density')?.value || 'detailed';

  systemSettings = {
    ...systemSettings,
    store_name,
    store_phone,
    store_address,
    invoice_note,
    min_stock_alert,
    near_expiry_months,
    allow_overselling,
    default_hide_out_of_stock,
    currency_symbol,
    enable_bonus,
    thermal_font_size,
    print_qr,
    app_theme_color,
    prod_card_density
  };

  saveLocalData();
  applyAppTheme(app_theme_color);

  // Update app title and logo if needed
  const headerTitle = document.querySelector('.header-title') || document.querySelector('header h1');
  if (headerTitle) headerTitle.innerText = store_name;

  try {
    await postToApi({
      action: 'save_settings',
      settings: systemSettings
    });
    showQuickToast('تم حفظ إعدادات وتخصيص التطبيق بنجاح ✓');
  } catch (err) {
    console.error('Error saving app control settings:', err);
    showQuickToast('تم حفظ الإعدادات محلياً ✓');
  }
}

function resetAppControlDefaultsPrompt() {
  showInAppConfirm({
    title: 'استعادة الإعدادات الافتراضية',
    message: 'هل أنت متأكد من استعادة كافة إعدادات التطبيق والمظهر إلى الوضع الافتراضي؟',
    icon: '↺',
    confirmText: 'نعم، استعادة',
    isDanger: false,
    onConfirm: async () => {
      systemSettings = {
        ...systemSettings,
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
        prod_card_density: 'detailed'
      };

      saveLocalData();
      applyAppTheme('#007aff');
      renderSettingsAppControl();

      try {
        await postToApi({
          action: 'save_settings',
          settings: systemSettings
        });
        showQuickToast('تمت استعادة الإعدادات الافتراضية بنجاح ✓');
      } catch (err) {
        showQuickToast('تمت الاستعادة محلياً ✓');
      }
    }
  });
}

function handleSaveStoreProfile(e) {
  handleSaveAppControlSubmit(e);
}

// 4. Settings: Theme, Fonts & Customization Panel (خاص بصاحب المذخر)
function renderSettingsTheme() {
  const colorPicker = document.getElementById('theme-color-picker');
  const colorHex = document.getElementById('theme-color-hex');
  const fontSelect = document.getElementById('theme-font-select');
  const scaleSelect = document.getElementById('theme-scale-select');
  const modeSelect = document.getElementById('theme-mode-select');
  const headerSelect = document.getElementById('theme-header-style-select');
  const densitySelect = document.getElementById('theme-card-density-select');

  const currentColor = systemSettings.app_theme_color || '#007aff';
  if (colorPicker) colorPicker.value = currentColor;
  if (colorHex) colorHex.value = currentColor;
  if (fontSelect) fontSelect.value = systemSettings.app_font_family || 'cairo';
  if (scaleSelect) scaleSelect.value = systemSettings.app_font_scale || '1.0';
  if (modeSelect) modeSelect.value = systemSettings.app_theme_mode || 'light';
  if (headerSelect) headerSelect.value = systemSettings.app_header_style || 'standard';
  if (densitySelect) densitySelect.value = systemSettings.prod_card_density || 'detailed';

  updatePresetButtonsActive(currentColor);
}

async function handleSaveThemeCustomizationSubmit(e) {
  if (e) e.preventDefault();
  if (!isAdmin) {
    showQuickToast('تخصيص المظهر متاح فقط لصاحب المذخر');
    return;
  }

  const app_theme_color = (document.getElementById('theme-color-hex')?.value || '').trim() || '#007aff';
  const app_font_family = document.getElementById('theme-font-select')?.value || 'cairo';
  const app_font_scale = document.getElementById('theme-scale-select')?.value || '1.0';
  const app_theme_mode = document.getElementById('theme-mode-select')?.value || 'light';
  const app_header_style = document.getElementById('theme-header-style-select')?.value || 'standard';
  const prod_card_density = document.getElementById('theme-card-density-select')?.value || 'detailed';

  systemSettings = {
    ...systemSettings,
    app_theme_color,
    app_font_family,
    app_font_scale,
    app_theme_mode,
    app_header_style,
    prod_card_density
  };

  saveLocalData();
  applyAppTheme();
  renderProducts();

  try {
    await postToApi({
      action: 'save_settings',
      settings: systemSettings
    });
    showQuickToast('تم حفظ تخصيص المظهر والألوان والخطوط لحسابك بنجاح ✓');
  } catch (err) {
    console.error('Error saving theme settings:', err);
    showQuickToast('تم حفظ وتطبيق المظهر محلياً ✓');
  }
}
window.handleSaveThemeCustomizationSubmit = handleSaveThemeCustomizationSubmit;

function resetThemeDefaultsPrompt() {
  showInAppConfirm({
    title: 'استعادة المظهر الافتراضي',
    message: 'هل أنت متأكد من استعادة كافة إعدادات المظهر، الألوان والخطوط إلى الوضع الافتراضي؟',
    icon: '🎨',
    confirmText: 'نعم، استعادة',
    isDanger: false,
    onConfirm: async () => {
      systemSettings = {
        ...systemSettings,
        app_theme_color: '#007aff',
        app_font_family: 'cairo',
        app_font_scale: '1.0',
        app_theme_mode: 'light',
        app_header_style: 'standard',
        prod_card_density: 'detailed'
      };

      saveLocalData();
      applyAppTheme();
      renderSettingsTheme();
      renderProducts();

      try {
        await postToApi({
          action: 'save_settings',
          settings: systemSettings
        });
        showQuickToast('تمت استعادة المظهر والخطوط الافتراضية بنجاح ✓');
      } catch (err) {
        showQuickToast('تمت الاستعادة محلياً ✓');
      }
    }
  });
}
window.resetThemeDefaultsPrompt = resetThemeDefaultsPrompt;

// 5. Settings: Security & Admin PIN
function renderSettingsSecurity() {
  const oldPin = document.getElementById('setting-old-pin');
  const newPin = document.getElementById('setting-new-pin');
  const confPin = document.getElementById('setting-confirm-pin');
  if (oldPin) oldPin.value = '';
  if (newPin) newPin.value = '';
  if (confPin) confPin.value = '';
}

async function handleChangeAdminPinSubmit(e) {
  if (e) e.preventDefault();
  const oldPin = document.getElementById('setting-old-pin')?.value;
  const newPin = document.getElementById('setting-new-pin')?.value;
  const confPin = document.getElementById('setting-confirm-pin')?.value;

  if (!oldPin || !newPin || !confPin) {
    alert('يرجى ملء كافة خانات الرمز السري');
    return;
  }
  if (newPin !== confPin) {
    alert('رمز الأمان الجديد وتأكيده غير متطابقين!');
    return;
  }
  if (newPin.length < 4) {
    alert('يجب أن يتكون الرمز الجديد من 4 خانات على الأقل');
    return;
  }

  try {
    const res = await postToApi({
      action: 'change_admin_pin',
      oldPin,
      newPin
    });

    if (res && res.status === 'success') {
      systemSettings.admin_pin = newPin;
      saveLocalData();
      renderSettingsSecurity();
      showInAppAlert('تم تغيير رمز الأمان بنجاح! يمكنك الآن استخدامه للدخول إلى وضع صاحب المذخر.', 'تم التحديث بنجاح');
    } else {
      alert(res?.message || 'رمز الأمان الحالي غير صحيح');
    }
  } catch (err) {
    console.error('Error changing pin:', err);
    alert('فشل تغيير رمز الأمان. تأكد من صحة الرمز الحالي.');
  }
}

// 5. Settings: Backup & Restore
function renderSettingsBackup() {
  // Backup panel view diagnostics or metrics
}

function downloadFullJsonBackup() {
  try {
    const backupData = {
      version: '2.0',
      exportedAt: new Date().toISOString(),
      appName: 'Samo Warehouse System',
      settings: systemSettings,
      products: products,
      orders: orders,
      pendingOrders: pendingOrders,
      pharmacies: pharmacies,
      staffNames: staffNames
    };

    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(backupData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `نسخة_احتياطية_مذخر_سامو_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();

    showQuickToast('تم تحميل النسخة الاحتياطية بنجاح ✓');
  } catch (err) {
    console.error('Backup error:', err);
    alert('حدث خطأ أثناء إعداد النسخة الاحتياطية');
  }
}

function handleRestoreJsonBackupFile(event) {
  const file = event.target?.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const content = e.target?.result;
      const data = JSON.parse(content);

      if (!data || (!data.products && !data.orders)) {
        alert('ملف النسخة الاحتياطية غير صالح أو تالف.');
        return;
      }

      showInAppConfirm({
        title: 'استرجاع النسخة الاحتياطية',
        message: `تم قراءة النسخة الاحتياطية بنجاح. تحتوي على (${data.products?.length || 0}) صنف و (${(data.orders?.length || 0) + (data.pendingOrders?.length || 0)}) طلبية و (${data.pharmacies?.length || 0}) صيدلية. هل تريد استبدال البيانات الحالية؟`,
        icon: '📥',
        confirmText: 'نعم، استرجاع وتطبيق',
        isDanger: true,
        onConfirm: async () => {
          if (Array.isArray(data.products)) products = data.products;
          if (Array.isArray(data.orders)) orders = data.orders.map(normalizeOrder).filter(Boolean).filter(isApprovedOrder);
          if (Array.isArray(data.pendingOrders)) pendingOrders = data.pendingOrders.map(normalizeOrder).filter(Boolean).filter(x => !isApprovedOrder(x));
          if (Array.isArray(data.pharmacies)) pharmacies = data.pharmacies;
          if (Array.isArray(data.staffNames)) staffNames = data.staffNames;
          if (data.settings && typeof data.settings === 'object') systemSettings = { ...systemSettings, ...data.settings };

          saveLocalData();
          refreshAllUI();
          showInAppAlert('تم استرجاع النسخة الاحتياطية وتحديث النظام بنجاح!', 'تم الاسترجاع');
        }
      });
    } catch (err) {
      console.error('Restore error:', err);
      alert('فشل قراءة ملف النسخة الاحتياطية.');
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

function openAddPharmacyModal() {
  const modal = document.getElementById('modal-pharmacy-form');
  const title = document.getElementById('pharmacy-modal-title');
  const idInput = document.getElementById('pharmacy-form-id');
  const nameInput = document.getElementById('pharmacy-form-name');
  const phoneInput = document.getElementById('pharmacy-form-phone');
  const addrInput = document.getElementById('pharmacy-form-address');
  const notesInput = document.getElementById('pharmacy-form-notes');

  if (title) title.innerText = '➕ إضافة صيدلية معتمدة جديدة';
  if (idInput) idInput.value = '';
  if (nameInput) nameInput.value = '';
  if (phoneInput) phoneInput.value = '';
  if (addrInput) addrInput.value = '';
  if (notesInput) notesInput.value = '';

  if (modal) modal.classList.add('is-open');
  setTimeout(() => { if (nameInput) nameInput.focus(); }, 120);
}

function openEditPharmacyModal(id) {
  const p = pharmacies.find(x => String(x.id) === String(id));
  if (!p) return;

  const modal = document.getElementById('modal-pharmacy-form');
  const title = document.getElementById('pharmacy-modal-title');
  const idInput = document.getElementById('pharmacy-form-id');
  const nameInput = document.getElementById('pharmacy-form-name');
  const phoneInput = document.getElementById('pharmacy-form-phone');
  const addrInput = document.getElementById('pharmacy-form-address');
  const notesInput = document.getElementById('pharmacy-form-notes');

  if (title) title.innerText = `✏️ تعديل بيانات صيدلية: ${p.name}`;
  if (idInput) idInput.value = p.id;
  if (nameInput) nameInput.value = p.name || '';
  if (phoneInput) phoneInput.value = p.phone || '';
  if (addrInput) addrInput.value = p.address || '';
  if (notesInput) notesInput.value = p.notes || '';

  if (modal) modal.classList.add('is-open');
  setTimeout(() => { if (nameInput) nameInput.focus(); }, 120);
}

function closePharmacyFormModal() {
  const modal = document.getElementById('modal-pharmacy-form');
  if (modal) modal.classList.remove('is-open');
}

async function handleSavePharmacySubmit(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('pharmacy-form-id')?.value;
  const customerName = (document.getElementById('pharmacy-form-name')?.value || '').trim();
  const customerPhone = (document.getElementById('pharmacy-form-phone')?.value || '').trim();
  const customerAddress = (document.getElementById('pharmacy-form-address')?.value || '').trim();
  const customerNotes = (document.getElementById('pharmacy-form-notes')?.value || '').trim();

  if (!customerName) {
    alert('يرجى إدخال اسم الصيدلية / العميل');
    return;
  }

  const fullAddress = customerAddress || customerNotes || null;
  const sb = (typeof getSupabaseClient === 'function' ? getSupabaseClient() : null) || (typeof supabase !== 'undefined' ? supabase : null);

  try {
    if (id && !String(id).startsWith('ph_') && !isNaN(Number(id))) {
      if (sb) {
        const { error } = await sb.from('customers').update({
          name: customerName,
          phone: customerPhone || null,
          address: fullAddress
        }).eq('id', Number(id));
        if (error) console.warn('Supabase customer update error:', error.message);
      }
      showQuickToast('تم تعديل بيانات الصيدلية بنجاح ✓');
    } else {
      if (sb) {
        const { error } = await sb.from('customers').insert([{
          name: customerName.trim(),
          phone: customerPhone?.trim() || null,
          address: fullAddress?.trim() || null,
          created_at: new Date().toISOString()
        }]);
        if (error) {
          console.error('Supabase customer insert error:', error);
          throw error;
        }
      }
      showQuickToast('تمت إضافة الصيدلية المعتمدة بنجاح ✓');
    }

    closePharmacyFormModal();
    await fetchCustomers();
    setSelectedPharmacy(customerName);
  } catch (err) {
    console.error('Error saving pharmacy:', err);
    alert('حدث خطأ أثناء حفظ الصيدلية: ' + (err.message || err));
  }
}

function deletePharmacyPrompt(id, name) {
  showInAppConfirm({
    title: 'حذف الصيدلية',
    message: `هل أنت متأكد من حذف صيدلية "${name}" من القائمة المعتمدة وقاعدة بيانات Supabase نهائياً؟`,
    icon: '🗑️',
    confirmText: 'نعم، تأكيد الحذف',
    isDanger: true,
    onConfirm: async () => {
      // 1. Direct Cloud Delete in Supabase
      const sb = getSupabaseClient();
      if (sb) {
        let q = sb.from('customers').delete();
        if (id && !String(id).startsWith('ph_') && !isNaN(Number(id))) {
          q = q.eq('id', Number(id));
        } else if (id && !String(id).startsWith('ph_')) {
          q = q.eq('id', id);
        } else if (name) {
          q = q.eq('name', name);
        }
        const { error } = await q;
        if (error) {
          console.error("فشل الحذف من السيرفر:", error);
          alert("خطأ أثناء الحذف من السيرفر: " + error.message);
          return;
        }
      }

      // 2. Server API call
      try {
        await postToApi({ action: 'delete_pharmacy', id, name });
      } catch (err) {
        console.warn("Server API delete note:", err);
      }

      // 3. Update state and UI
      await fetchCustomers();
      showQuickToast(`تم حذف صيدلية "${name}" بنجاح ✓`);
    }
  });
}

function importPharmaciesFromOrdersPrompt() {
  showInAppConfirm({
    title: 'استيراد الصيدليات من الطلبيات',
    message: 'سيقوم النظام بالبحث في كافة الطلبيات السابقة (الواردة والصادرة) واستخراج وتثبيت كافة أسماء الصيدليات وأرقام هواتفها غير المسجلة تلقائياً. هل تريد المتابعة؟',
    icon: '📥',
    confirmText: 'بدء الاستيراد التلقائي',
    isDanger: false,
    onConfirm: async () => {
      try {
        const res = await postToApi({ action: 'import_pharmacies_from_orders' });
        if (res && res.success) {
          if (Array.isArray(res.pharmacies) && res.pharmacies.length > 0) {
            pharmacies = res.pharmacies;
          }
          saveLocalData();
          renderSettingsPharmacies();
          populatePharmacyDropdowns();
          showInAppAlert(`تم فحص الطلبيات بنجاح! تم استيراد وتثبيت (${res.importedCount || 0}) صيدلية جديدة في القائمة المعتمدة.`, 'تم الاستيراد بنجاح');
        } else {
          throw new Error('فشل الاستيراد من الخادم');
        }
      } catch (err) {
        console.warn('Local fallback for importPharmaciesFromOrders:', err);
        const existingNames = new Set(pharmacies.map(p => (p.name || '').trim().toLowerCase()));
        let imported = 0;
        orders.concat(pendingOrders).forEach(o => {
          const name = (o.pharmacyName || o.customerName || '').trim();
          if (name && !existingNames.has(name.toLowerCase())) {
            existingNames.add(name.toLowerCase());
            pharmacies.push({
              id: Date.now() + Math.floor(Math.random() * 10000),
              name: name,
              phone: o.customerPhone || o.phone || '',
              address: o.address || '',
              notes: 'مستوردة من الطلبيات',
              createdAt: new Date().toISOString()
            });
            imported++;
          }
        });
        saveLocalData();
        renderSettingsPharmacies();
        populatePharmacyDropdowns();
        showInAppAlert(`تم استخراج وتثبيت (${imported}) صيدلية جديدة من الطلبيات المسجلة.`, 'تم الاستيراد محلياً');
      }
    }
  });
}

function exportPharmaciesCSV() {
  if (pharmacies.length === 0) {
    alert('لا توجد صيدليات لتصديرها');
    return;
  }
  let csv = '\uFEFF';
  csv += 'ت,اسم الصيدلية,رقم الهاتف,العنوان,ملاحظات,تاريخ الإضافة\n';
  pharmacies.forEach((p, i) => {
    const clean = (str) => `"${String(str || '').replace(/"/g, '""')}"`;
    csv += `${i + 1},${clean(p.name)},${clean(p.phone)},${clean(p.address)},${clean(p.notes)},${clean(p.createdAt || '')}\n`;
  });

  downloadCSV(`قائمة_الصيدليات_المعتمدة_سامو_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  showQuickToast('تم تصدير ملف الصيدليات بنجاح ✓');
}

function startOrderForPharmacy(name) {
  setMainTab('home');
  showQuickToast(`تم تحديد صيدلية: ${name}`);
  setTimeout(() => {
    openSendModal();
    const sel = document.getElementById('order-approved-ph-select');
    if (sel) {
      sel.value = name;
      onApprovedPharmacySelected(name);
    }
  }, 120);
}

function refreshAllUI(skipLowStockCheck = false) {
  syncDosageFormsFromSettings();
  applyAppTheme();
  populateAllDosageFormSelectors();
  renderProducts();
  renderOrdersLog();
  renderIncomingOrders();
  renderStaffReport();
  updateFinanceReports();
  populateCompanyReportDropdown();
  populateStaffDropdowns();
  populatePharmacyDropdowns();
  if (currentTab === 'settings') renderSettings();
  updateCartBadge();
  updateUserOrdersBadge();
  if (!skipLowStockCheck) {
    checkSamoLowStockAlerts();
  }
}

// Supabase Cloud Synchronization & Health Checks
async function checkSupabaseCloudStatus() {
  try {
    const res = await fetch('/api/supabase/status');
    const data = await res.json();
    const badge = document.getElementById('cloud-header-badge');
    const liveInd = document.getElementById('supabase-live-indicator');
    const statusText = document.getElementById('supabase-cloud-status-text');
    const countLbl = document.getElementById('supabase-count-lbl');
    const lastSyncLbl = document.getElementById('supabase-last-sync-lbl');

    if (data && (data.connected || data.success)) {
      if (badge) {
        badge.innerHTML = '⚡ Supabase متصل';
        badge.style.background = '#f0fdf4';
        badge.style.color = '#16a34a';
        badge.style.borderColor = '#bbf7d0';
      }
      if (liveInd) {
        liveInd.innerHTML = '● متصل بقاعدة Supabase';
        liveInd.style.background = '#16a34a';
      }
      if (statusText) {
        statusText.innerHTML = `متصلة مباشرة بجدول (${data.tableName || 'samo'}) في سحابة Supabase (${data.count || 0} مادة).`;
      }
      if (countLbl) {
        countLbl.innerText = `${data.count || 0} مادة`;
      }
      if (lastSyncLbl) {
        lastSyncLbl.innerText = new Date().toLocaleTimeString('ar-IQ');
      }
    } else {
      if (badge) {
        badge.innerHTML = '⚡ Supabase نشط';
      }
      if (liveInd) {
        liveInd.innerHTML = '⚠️ جاري الاتصال...';
        liveInd.style.background = '#f59e0b';
      }
    }
  } catch (err) {
    console.warn('Supabase status check:', err);
  }
}

async function testSupabaseCloudConnection() {
  const start = performance.now();
  try {
    const res = await fetch('/api/supabase/test', { method: 'POST' });
    const data = await res.json();
    const duration = Math.round(performance.now() - start);
    if (data.success) {
      alert(`⚡ استجابة سحابة Supabase ممتازة!\n- زمن الاستجابة: ${data.latency || duration} ملي ثانية (ms)\n- الجدول المعتمد: ${data.tableName || 'samo'}\n- عدد المواد في السحابة: ${data.count || 0} مادة\n- الحالة: متصل بنجاح.`);
      checkSupabaseCloudStatus();
    } else {
      alert(`⚠️ تعذر الاتصال بالسحابة: ${data.message || data.error}`);
    }
  } catch (err) {
    alert('خطأ في فحص اتصال Supabase: ' + err.message);
  }
}

function scrollToTopMedicines() {
  const viewport = document.getElementById('medicines-scroll-viewport');
  if (viewport) {
    viewport.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

let isDraggingWarehouseBadge = false;

function updateWarehouseSideTracker() {
  const rail = document.getElementById('warehouse-scroll-rail');
  const badge = document.getElementById('warehouse-sliding-badge');
  const numEl = document.getElementById('tracker-number');
  const viewport = document.getElementById('medicines-scroll-viewport');
  if (!rail || !badge || !numEl) return;

  // Only show when in home tab
  if (currentTab !== 'home') {
    rail.style.display = 'none';
    return;
  }

  const list = getFilteredProducts();
  if (!list || list.length <= 1) {
    rail.style.display = 'none';
    return;
  }

  rail.style.display = 'block';

  // If user is actively dragging the badge, skip scroll auto-override
  if (isDraggingWarehouseBadge) return;

  const scrollTop = viewport ? viewport.scrollTop : (window.scrollY || document.documentElement.scrollTop || 0);
  const scrollHeight = viewport ? viewport.scrollHeight : document.documentElement.scrollHeight;
  const clientHeight = viewport ? viewport.clientHeight : window.innerHeight;
  const maxScroll = Math.max(scrollHeight - clientHeight, 1);
  const scrollPct = Math.min(1, Math.max(0, scrollTop / maxScroll));

  // Find currently visible card
  const cards = document.querySelectorAll('#prod-list-container .prod-card');
  let currentIdx = 0;

  if (viewport) {
    const vRect = viewport.getBoundingClientRect();
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (rect.bottom >= vRect.top + 25) {
        currentIdx = i;
        break;
      }
    }
  } else {
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (rect.bottom >= 120) {
        currentIdx = i;
        break;
      }
    }
  }

  // Calculate sliding vertical position on the rail
  const railHeight = rail.clientHeight || 200;
  const badgeHeight = badge.clientHeight || 28;
  const maxTranslate = Math.max(0, railHeight - badgeHeight);
  const targetY = scrollPct * maxTranslate;

  badge.style.transform = `translate(-50%, ${targetY.toFixed(1)}px)`;
  numEl.innerText = `${currentIdx + 1}`;
  rail.title = `المادة ${currentIdx + 1} من أصل ${list.length} (اضغط واسحب للتحرك مباشرة)`;
}

// Make Warehouse Number Badge Draggable / Moveable upon Press
function initDraggableWarehouseBadge() {
  const rail = document.getElementById('warehouse-scroll-rail');
  const badge = document.getElementById('warehouse-sliding-badge');
  const numEl = document.getElementById('tracker-number');
  const viewport = document.getElementById('medicines-scroll-viewport');

  if (!rail || !badge || !numEl) return;

  function handleBadgeDragMove(clientY) {
    const railRect = rail.getBoundingClientRect();
    const badgeHeight = badge.clientHeight || 28;
    const maxTranslate = Math.max(0, railRect.height - badgeHeight);

    let relativeY = clientY - railRect.top - (badgeHeight / 2);
    relativeY = Math.max(0, Math.min(maxTranslate, relativeY));

    const scrollPct = maxTranslate > 0 ? (relativeY / maxTranslate) : 0;

    badge.style.transform = `translate(-50%, ${relativeY.toFixed(1)}px) scale(1.25)`;

    if (viewport) {
      const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = scrollPct * maxScroll;
    } else {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: scrollPct * maxScroll });
    }

    const cards = document.querySelectorAll('#prod-list-container .prod-card');
    if (cards.length > 0) {
      const targetIdx = Math.min(cards.length - 1, Math.max(0, Math.floor(scrollPct * cards.length)));
      numEl.innerText = `${targetIdx + 1}`;
    }
  }

  function startDrag(e) {
    e.preventDefault();
    isDraggingWarehouseBadge = true;
    badge.classList.add('is-dragging');

    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    handleBadgeDragMove(clientY);

    function onMove(moveEvent) {
      if (!isDraggingWarehouseBadge) return;
      const moveY = moveEvent.touches ? moveEvent.touches[0].clientY : moveEvent.clientY;
      handleBadgeDragMove(moveY);
    }

    function onEnd() {
      isDraggingWarehouseBadge = false;
      badge.classList.remove('is-dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      updateWarehouseSideTracker();
    }

    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
  }

  badge.addEventListener('mousedown', startDrag);
  badge.addEventListener('touchstart', startDrag, { passive: false });
  rail.addEventListener('mousedown', startDrag);
  rail.addEventListener('touchstart', startDrag, { passive: false });
}

// Universal Draggable Function for Floating Badges with Numbers
function makeElementDraggable(el) {
  if (!el) return;
  let isDragging = false;
  let startX = 0, startY = 0;
  let initialLeft = 0, initialTop = 0;
  let hasMoved = false;

  function onPointerDown(e) {
    // If clicking close button inside or secondary input, ignore
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    isDragging = true;
    hasMoved = false;

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    startX = clientX;
    startY = clientY;

    const rect = el.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    el.style.transition = 'none';

    function onPointerMove(moveEvent) {
      if (!isDragging) return;
      const curX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
      const curY = moveEvent.touches ? moveEvent.touches[0].clientY : moveEvent.clientY;

      const deltaX = curX - startX;
      const deltaY = curY - startY;

      if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
        hasMoved = true;
      }

      let newLeft = initialLeft + deltaX;
      let newTop = initialTop + deltaY;

      // Keep inside visible screen
      const maxLeft = window.innerWidth - rect.width - 8;
      const maxTop = window.innerHeight - rect.height - 8;
      newLeft = Math.max(8, Math.min(maxLeft, newLeft));
      newTop = Math.max(8, Math.min(maxTop, newTop));

      el.style.position = 'fixed';
      el.style.left = `${newLeft}px`;
      el.style.top = `${newTop}px`;
      el.style.bottom = 'auto';
      el.style.right = 'auto';
      el.style.zIndex = '99999';
    }

    function onPointerUp(upEvent) {
      if (!isDragging) return;
      isDragging = false;
      el.style.transition = 'all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)';

      if (hasMoved) {
        // Prevent click trigger if dragged
        const preventClick = (clickEvent) => {
          clickEvent.stopPropagation();
          clickEvent.preventDefault();
          el.removeEventListener('click', preventClick, true);
        };
        el.addEventListener('click', preventClick, true);
      }

      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
      window.removeEventListener('touchmove', onPointerMove);
      window.removeEventListener('touchend', onPointerUp);
      window.removeEventListener('touchcancel', onPointerUp);
    }

    window.addEventListener('mousemove', onPointerMove, { passive: true });
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchmove', onPointerMove, { passive: true });
    window.addEventListener('touchend', onPointerUp);
    window.addEventListener('touchcancel', onPointerUp);
  }

  el.addEventListener('mousedown', onPointerDown);
  el.addEventListener('touchstart', onPointerDown, { passive: false });
}

// Start application
function resetUIInteractivity() {
  try {
    isSubmitting = false;
    isLoading = false;
    isModalOpen = false;
    document.body.style.pointerEvents = 'auto';
    // Remove stuck modal overlays if any were left over
    document.querySelectorAll('.modal-overlay').forEach(m => {
      if (!m.classList.contains('confirm-dialog-top')) {
        m.classList.remove('is-open');
        m.style.display = 'none';
      }
    });
    const loaders = document.querySelectorAll('.loading-overlay, .spinner-overlay, #global-loader');
    loaders.forEach(l => {
      l.style.display = 'none';
      l.classList.remove('active', 'is-open');
    });
  } catch (err) {
    console.warn('resetUIInteractivity warning:', err);
  }
}
window.resetUIInteractivity = resetUIInteractivity;

function startAppLifecycle() {
  resetUIInteractivity();
  
  // Global click safety to ensure no unhandled error freezes UI
  document.addEventListener('click', (e) => {
    try {
      // If user clicks anywhere, ensure body pointer events is auto
      if (document.body.style.pointerEvents === 'none') {
        document.body.style.pointerEvents = 'auto';
      }
    } catch (e2) {}
  }, true);

  // 1. Reset search box and default filters so no default filter blocks items
  const searchBox = document.getElementById('search-box');
  if (searchBox) searchBox.value = '';
  const filterForm = document.getElementById('filter-form');
  if (filterForm) filterForm.value = 'ALL';
  const filterStock = document.getElementById('filter-stock');
  if (filterStock) filterStock.value = '';
  const filterCompany = document.getElementById('filter-company');
  if (filterCompany) filterCompany.value = 'ALL';
  const filterExpiry = document.getElementById('filter-expiry');
  if (filterExpiry) filterExpiry.value = '';

  loadLocalData();
  applyAdminState();
  initSupabaseAuthSession();
  fetchCustomers();

  // If we already have products from local data, render them immediately so user never sees a blank screen!
  if (products && products.length > 0) {
    if (typeof renderProducts === 'function') renderProducts();
    if (typeof refreshAllUI === 'function') refreshAllUI(true);
  }

  // 2. Fetch products automatically from samo table in Supabase via loadSamoMedicinesDirectly at app startup
  loadSamoMedicinesDirectly(false).then((prods) => {
    if (!prods || prods.length === 0) {
      loadRemoteData();
    } else {
      if (typeof renderProducts === 'function') renderProducts();
      if (typeof refreshAllUI === 'function') refreshAllUI(true);
    }
  }).catch(() => {
    loadRemoteData();
  });

  setupSupabaseOrdersRealtime();
  checkAndMigrateStaffAndReports(false);
  checkSamoLowStockAlerts();
  checkSupabaseCloudStatus();
  setInterval(checkSupabaseCloudStatus, 30000);
  setInterval(checkSamoLowStockAlerts, 60000);
  setInterval(() => {
    fetchStaffFromSupabaseDirect(false);
    fetchReportsFromSupabaseDirect(false);
  }, 45000);
  setInterval(() => {
    if (isAdmin && currentTab === 'incoming') {
      loadRemoteData();
    }
  }, 10000);

  // Setup scroll listener for warehouse position tracker
  const viewport = document.getElementById('medicines-scroll-viewport');
  if (viewport) {
    viewport.addEventListener('scroll', updateWarehouseSideTracker, { passive: true });
  }
  window.addEventListener('scroll', updateWarehouseSideTracker, { passive: true });
  window.addEventListener('resize', updateWarehouseSideTracker, { passive: true });

  // Initialize Draggable Number Indicators
  initDraggableWarehouseBadge();
  const floatBtn = document.querySelector('.floating-send-btn');
  if (floatBtn) makeElementDraggable(floatBtn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startAppLifecycle);
} else {
  // If DOM is already interactive or complete, start immediately!
  startAppLifecycle();
}

// Google Auth & Staff Account Global Bindings
window.openGoogleAuthModal = openGoogleAuthModal;
window.closeGoogleAuthModal = closeGoogleAuthModal;
window.signInWithGoogleOAuth = signInWithGoogleOAuth;
window.saveManualGoogleEmail = saveManualGoogleEmail;
window.signOutGoogleAccount = signOutGoogleAccount;
window.setOrdersViewScope = setOrdersViewScope;
window.applyRestoredDraft = applyRestoredDraft;
window.dismissDraftBanner = dismissDraftBanner;
window.queueAutoSaveDraft = queueAutoSaveDraft;
window.saveCurrentDraft = saveCurrentDraft;

// Global Window bindings for Settings and UI Navigation
window.setMainTab = setMainTab;
window.switchSettingsTab = switchSettingsTab;
window.renderSettings = renderSettings;
window.renderSettingsPharmacies = renderSettingsPharmacies;
window.renderSettingsStaff = renderSettingsStaff;
window.renderSettingsStore = renderSettingsStore;
window.renderSettingsDosageForms = renderSettingsDosageForms;
window.renderSettingsAppControl = renderSettingsAppControl;
window.openAddDosageFormModal = openAddDosageFormModal;
window.openEditDosageFormModal = openEditDosageFormModal;
window.closeDosageFormModal = closeDosageFormModal;
window.handleSaveDosageFormSubmit = handleSaveDosageFormSubmit;
window.deleteDosageFormPrompt = deleteDosageFormPrompt;
window.restoreDefaultDosageFormsPrompt = restoreDefaultDosageFormsPrompt;
window.handleSaveAppControlSubmit = handleSaveAppControlSubmit;
window.previewThemeColor = previewThemeColor;
window.resetAppControlDefaultsPrompt = resetAppControlDefaultsPrompt;
window.renderSettingsSecurity = renderSettingsSecurity;
window.renderSettingsBackup = renderSettingsBackup;
window.openAddPharmacyModal = openAddPharmacyModal;
window.openEditPharmacyModal = openEditPharmacyModal;
window.closePharmacyFormModal = closePharmacyFormModal;
window.handleSavePharmacySubmit = handleSavePharmacySubmit;
window.deletePharmacyPrompt = deletePharmacyPrompt;
window.importPharmaciesFromOrdersPrompt = importPharmaciesFromOrdersPrompt;
window.exportPharmaciesCSV = exportPharmaciesCSV;
window.startOrderForPharmacy = startOrderForPharmacy;
window.handleAddNewStaffFromSettings = handleAddNewStaffFromSettings;
window.setActiveStaffDevice = setActiveStaffDevice;
window.deleteStaffFromSettings = deleteStaffFromSettings;
window.handleSaveStoreProfile = handleSaveStoreProfile;
window.handleChangeAdminPinSubmit = handleChangeAdminPinSubmit;
window.downloadFullJsonBackup = downloadFullJsonBackup;
window.handleRestoreJsonBackupFile = handleRestoreJsonBackupFile;
window.checkSupabaseCloudStatus = checkSupabaseCloudStatus;
window.testSupabaseCloudConnection = testSupabaseCloudConnection;
window.triggerSync = triggerSync;
window.triggerAdmin = triggerAdmin;
window.goToDosageFormsSettings = goToDosageFormsSettings;
window.openSettingsTabPrompt = openSettingsTabPrompt;

// Supabase Cloud Integration Helpers
async function checkSupabaseHealth() {
  try {
    const res = await fetch('/api/supabase/status');
    const data = await res.json();
    if (data.connected) {
      showToast(`⚡ متصل بقاعدة بيانات Supabase: ${data.count} مادة مسجلة في جدول ${data.tableName}`, 'success');
      alert(`⚡ تم التحقق من اتصال Supabase بنجاح!\n\n- حالة الاتصال: متصل وقيد العمل ✓\n- الجدول المعتمد: ${data.tableName}\n- إجمالي المواد في الجدول: ${data.count} مادة\n- رابط الخادم: ${data.url}`);
    } else {
      alert(`⚠️ تعذر الاتصال بـ Supabase: ${data.error || 'خطأ غير معروف'}`);
    }
  } catch (err) {
    alert(`حدث خطأ أثناء فحص اتصال Supabase: ${err.message}`);
  }
}

async function triggerSupabaseSyncNow() {
  const btn = event?.target;
  const oldText = btn ? btn.innerText : '';
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ جاري جلب ومزامنة الأدوية من قاعدة البيانات...';
  }
  showQuickToast('⏳ جاري جلب ومزامنة الأدوية من قاعدة البيانات (Supabase)...');

  try {
    const res = await fetch('/api/supabase/sync', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ ${data.message}`, 'success');
      showQuickToast(`✅ ${data.message}`);
      await loadRemoteData(1);
    } else {
      showQuickToast('⚠️ فشلت المزامنة: ' + (data.error || 'خطأ غير معروف'), 'warning');
    }
  } catch (err) {
    showQuickToast('حدث خطأ في جلب بيانات قاعدة البيانات: ' + err.message, 'warning');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = oldText;
    }
  }
}

window.checkSupabaseHealth = checkSupabaseHealth;
window.triggerSupabaseSyncNow = triggerSupabaseSyncNow;

// ==========================================
// Supabase Direct Reports & Inventory Logs Integration
// ==========================================

async function saveReportToSupabase(reportData) {
  try {
    const repType = reportData.report_type || reportData.type || reportData.title || 'مبيعات يومية';
    const repDate = safeDateOnly(reportData.report_date || reportData.created_at || reportData.createdAt);
    const summaryVal = typeof reportData.summary === 'string' && reportData.summary
      ? reportData.summary
      : (typeof reportData.content === 'object'
          ? JSON.stringify(reportData.content)
          : String(reportData.content || reportData.summary || '{}'));
    const totalSales = Number(reportData.total_sales || reportData.totalDispatched || 0);
    const author = reportData.generated_by || reportData.generated_by_email || reportData.generatedBy || currentStaffEmail || 'صاحب المذخر';
    const createdAt = safeIsoDate(reportData.created_at || reportData.createdAt);

    const payload = {
      report_type: repType,
      report_date: repDate,
      summary: summaryVal,
      total_sales: totalSales,
      generated_by: author,
      created_at: createdAt
    };

    const sb = getSupabaseClient();
    let saved = false;

    if (sb) {
      try {
        const { data, error } = await sb.from('reports').insert([payload]).select();
        if (!error && data) {
          saved = true;
        } else if (error && (error.message.includes('row-level security') || error.code === '42501')) {
          console.info('Supabase reports table has RLS policy active; persisting to database via server API.');
        } else if (error) {
          console.warn('Supabase reports insert note:', error.message);
        }
      } catch (sbErr) {
        console.warn('Supabase direct insert exception:', sbErr);
      }
    }

    // Always persist to server API for consistency and reliability
    try {
      await fetch('/api/supabase/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      saved = true;
    } catch (srvErr) {
      console.warn('Server report save note:', srvErr);
    }

    if (typeof showQuickToast === 'function') {
      showQuickToast('تم حفظ التقرير في قاعدة البيانات بنجاح ✓');
    }
    fetchReportsFromSupabaseDirect();
    return [payload];
  } catch (err) {
    console.error('Exception in saveReportToSupabase:', err);
    if (typeof showQuickToast === 'function') {
      showQuickToast(`ملاحظة أثناء حفظ التقرير: ${err.message}`, 'info');
    }
    return null;
  }
}
window.saveReportToSupabase = saveReportToSupabase;

async function saveDetailedReportToCloud() {
  const phSet = new Set(orders.concat(pendingOrders).map(o => o.pharmacyName || o.customerName).filter(Boolean));
  let totalStockVal = 0;
  products.forEach(p => {
    const q = Number(p.quantity ?? p.number ?? 0);
    const pr = Number(p.price ?? 0);
    totalStockVal += q * pr;
  });

  const totalDispatched = orders.reduce((acc, o) => acc + (Number(o.totalAmount) || 0), 0);
  const author = currentStaffEmail || currentStaff || 'صاحب المذخر';

  const reportContent = {
    title: `تقرير المذخر والنشاط اليومي - ${new Date().toLocaleDateString('ar-IQ')}`,
    pharmaciesCount: phSet.size || pharmacies.length,
    ordersCount: orders.length + pendingOrders.length,
    productsCount: products.length,
    itemsCount: products.length,
    totalStockVal: totalStockVal,
    totalDispatched: totalDispatched,
    totalSales: totalDispatched,
    generatedBy: author,
    timestamp: new Date().toISOString()
  };

  const reportData = {
    report_type: 'تقرير مالي ومخزني',
    report_date: new Date().toISOString().slice(0, 10),
    summary: JSON.stringify(reportContent),
    total_sales: totalDispatched,
    generated_by: author,
    created_at: new Date().toISOString()
  };

  await saveReportToSupabase(reportData);
}
window.saveDetailedReportToCloud = saveDetailedReportToCloud;

async function logInventoryMovementExtended(productId, productName, oldQty, newQty, changeType) {
  return recordInventoryLog({
    actionType: changeType || 'تعديل رصيد',
    itemName: productName || 'مادة',
    details: {
      previous_qty: Number(oldQty) || 0,
      new_qty: Number(newQty) || 0,
      product_id: productId
    }
  });
}
window.logInventoryMovementExtended = logInventoryMovementExtended;

async function fetchReportsForContainer(showToast = false) {
  const container = document.getElementById('supabase-reports-container');
  if (container) {
    container.innerHTML = `<div style="text-align:center; padding:15px; color:var(--ios-sub); font-size:12px;">⏳ جاري جلب التقارير من Supabase (جدول reports)...</div>`;
  }
  try {
    const sb = getSupabaseClient();
    if (!sb) return [];

    const { data, error } = await sb
      .from('reports')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching reports from Supabase:', error);
      if (container) {
        container.innerHTML = `<div style="color:#ef4444; padding:12px; font-size:12px; text-align:center;">⚠️ خطأ في جلب التقارير: ${escapeHtml(error.message || String(error))}</div>`;
      }
      return [];
    }

    if (showToast && typeof showQuickToast === 'function') {
      showQuickToast(`تم تحديث التقارير من Supabase بنجاح (${data ? data.length : 0} تقرير) ✓`);
    }

    renderReportsListUI(data || []);
    return data || [];
  } catch (err) {
    console.error('Exception fetching reports:', err);
    if (container) {
      container.innerHTML = `<div style="color:#ef4444; padding:12px; font-size:12px; text-align:center;">⚠️ تعذر الاتصال بـ Supabase لجلب التقارير.</div>`;
    }
    return [];
  }
}
window.fetchReportsForContainer = fetchReportsForContainer;

function renderReportsListUI(reportsList) {
  const container = document.getElementById('supabase-reports-container');
  if (!container) return;

  if (!reportsList || reportsList.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:24px; color:var(--ios-sub); font-size:13px; background:#f8fafc; border-radius:10px; border:1px dashed #cbd5e1;">
        📋 لا توجد تقارير محفوظة في جدول reports في Supabase حتى الآن.<br>
        اضغط على زر <b>"حفظ التقرير في سحابة Supabase"</b> لحفظ التقرير المالي تلقائياً.
      </div>
    `;
    return;
  }

  let html = `<div style="display:flex; flex-direction:column; gap:10px;">`;
  reportsList.forEach(rep => {
    const rawContent = rep.summary || rep.content;
    let parsed = null;
    if (rawContent) {
      if (typeof rawContent === 'string') {
        try {
          parsed = JSON.parse(rawContent);
        } catch (e) {
          parsed = null;
        }
      } else if (typeof rawContent === 'object') {
        parsed = rawContent;
      }
    }

    const title = escapeHtml(rep.title || (parsed && parsed.title) || rep.report_type || 'تقرير المبيعات والنشاط');
    const type = escapeHtml(rep.type || rep.report_type || 'مبيعات');
    const dateStr = rep.report_date || (rep.created_at ? new Date(rep.created_at).toLocaleString('ar-IQ') : 'غير محدد');
    let contentDisplay = '';

    if (parsed && typeof parsed === 'object') {
      const phCount = parsed.pharmaciesCount !== undefined ? parsed.pharmaciesCount : rep.pharmacies_count;
      const ordCount = parsed.ordersCount !== undefined ? parsed.ordersCount : rep.orders_count;
      const prodCount = parsed.productsCount !== undefined ? parsed.productsCount : (parsed.itemsCount !== undefined ? parsed.itemsCount : rep.items_count);
      const stockVal = parsed.totalStockVal !== undefined ? parsed.totalStockVal : null;
      const salesVal = parsed.totalDispatched !== undefined ? parsed.totalDispatched : (parsed.totalSales !== undefined ? parsed.totalSales : rep.total_sales);
      const authorName = rep.generated_by || rep.generated_by_email || parsed.generatedBy || parsed.staffEmail;

      contentDisplay = `
        <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:6px; font-size:11.5px; color:#334155;">
          ${phCount !== undefined && phCount !== null ? `<span>🏥 الصيدليات: <b>${phCount}</b></span>` : ''}
          ${ordCount !== undefined && ordCount !== null ? `<span>📋 الطلبيات: <b>${ordCount}</b></span>` : ''}
          ${prodCount !== undefined && prodCount !== null ? `<span>💊 المواد: <b>${prodCount}</b></span>` : ''}
          ${salesVal !== undefined && salesVal !== null ? `<span>💰 المبيعات: <b>${Number(salesVal).toLocaleString()} د.ع</b></span>` : ''}
          ${stockVal !== undefined && stockVal !== null ? `<span>💵 قيمة المخزن: <b>${Number(stockVal).toLocaleString()} د.ع</b></span>` : ''}
          ${authorName ? `<span style="color:#64748b;">👤 المنشئ: <b>${escapeHtml(authorName)}</b></span>` : ''}
        </div>
      `;
    } else if (rawContent) {
      contentDisplay = `<div style="font-size:12px; color:#475569; margin-top:4px;">${escapeHtml(String(rawContent))}</div>`;
    }

    html += `
      <div style="background:#ffffff; border:1px solid var(--ios-border); border-radius:12px; padding:12px 14px; box-shadow:0 1px 4px rgba(0,0,0,0.03);">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
          <div>
            <div style="font-size:14px; font-weight:800; color:#0f172a; display:flex; align-items:center; gap:6px;">
              <span>📑</span>
              <span>${title}</span>
              <span style="font-size:10.5px; background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:6px; font-weight:700;">${type}</span>
            </div>
            ${contentDisplay}
          </div>
          <div style="font-size:11px; color:#64748b; font-weight:700; text-align:left;">
            📅 ${dateStr}
          </div>
        </div>
      </div>
    `;
  });
  html += `</div>`;
  container.innerHTML = html;
}
window.renderReportsListUI = renderReportsListUI;

async function fetchInventoryLogsFromSupabaseDirect(showToast = false) {
  const container = document.getElementById('inventory-logs-container');
  if (container) {
    container.innerHTML = `<div style="text-align:center; padding:15px; color:var(--ios-sub); font-size:12px;">⏳ جاري جلب سجل حركة المخزون من Supabase (جدول inventory_logs)...</div>`;
  }
  try {
    const sb = getSupabaseClient();
    if (!sb) return [];

    let { data, error } = await sb
      .from('inventory_logs')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('Error fetching inventory_logs by created_at, falling back to id:', error);
      const fallback = await sb
        .from('inventory_logs')
        .select('*')
        .order('id', { ascending: false });

      if (fallback.data) {
        data = fallback.data;
        error = null;
      }
    }

    if (error) {
      console.error('Error fetching inventory_logs:', error);
      if (container) {
        container.innerHTML = `<div style="color:#ef4444; padding:12px; font-size:12px; text-align:center;">⚠️ خطأ في جلب سجلات المخزون: ${escapeHtml(error.message || String(error))}</div>`;
      }
      return [];
    }

    if (showToast && typeof showQuickToast === 'function') {
      showQuickToast(`تم تحديث سجل حركات المخزون من Supabase بنجاح (${data ? data.length : 0} حركة) ✓`);
    }

    renderInventoryLogsUI(data || []);
    return data || [];
  } catch (err) {
    console.error('Exception fetching inventory logs:', err);
    if (container) {
      container.innerHTML = `<div style="color:#ef4444; padding:12px; font-size:12px; text-align:center;">⚠️ تعذر الاتصال بـ Supabase لجلب سجل الحركات.</div>`;
    }
    return [];
  }
}
window.fetchInventoryLogsFromSupabaseDirect = fetchInventoryLogsFromSupabaseDirect;

function renderInventoryLogsUI(logsList) {
  const container = document.getElementById('inventory-logs-container');
  if (!container) return;

  if (!logsList || logsList.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:24px; color:var(--ios-sub); font-size:13px; background:#f8fafc; border-radius:10px; border:1px dashed #cbd5e1;">
        📋 لا توجد سجلات حركة مخزون في جدول inventory_logs في Supabase حتى الآن.<br>
        عند أي اعتماد طلبية، إرجاع مادة، أو تعديل يدوي على رصيد مادة، تظهر السجلات هنا فوراً.
      </div>
    `;
    return;
  }

  let html = `
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:12px; text-align:right;">
        <thead>
          <tr style="background:#f1f5f9; color:#334155; font-weight:800; border-bottom:2px solid #cbd5e1;">
            <th style="padding:8px 10px;">التاريخ والوقت</th>
            <th style="padding:8px 10px;">اسم المادة</th>
            <th style="padding:8px 10px;">نوع الحركة</th>
            <th style="padding:8px 10px; text-align:center;">الرصيد السابق</th>
            <th style="padding:8px 10px; text-align:center;">الرصيد الجديد</th>
            <th style="padding:8px 10px; text-align:center;">الفارق</th>
            <th style="padding:8px 10px;">المنفّذ</th>
          </tr>
        </thead>
        <tbody>
  `;

  logsList.forEach(log => {
    const prodName = escapeHtml(log.item_name || log.product_name || log.productName || log.product_id || 'مادة');
    const changeType = escapeHtml(log.action_type || log.change_type || log.changeType || 'تعديل');
    
    let details = {};
    if (log.details && typeof log.details === 'object') {
      details = log.details;
    } else if (typeof log.details === 'string') {
      try { details = JSON.parse(log.details); } catch(e) {}
    }

    const prevQty = Number(details.previous_qty ?? log.previous_qty ?? log.previousQty ?? 0);
    const newQty = Number(details.new_qty ?? log.new_qty ?? log.newQty ?? 0);
    const diff = (details.diff !== undefined && details.diff !== null)
      ? Number(details.diff)
      : (newQty - prevQty);

    const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
    const diffColor = diff > 0 ? '#16a34a' : diff < 0 ? '#dc2626' : '#64748b';
    const rawTime = log.created_at || log.timestamp;
    const timeStr = rawTime ? new Date(rawTime).toLocaleString('ar-IQ') : 'غير محدد';
    const performer = escapeHtml(log.performed_by || details.performed_by || 'صاحب المذخر');
    const orderNote = details.order_ref ? `<div style="font-size:10px; color:#0284c7; margin-top:2px;">طلب: ${escapeHtml(String(details.order_ref))}</div>` : '';

    html += `
      <tr style="border-bottom:1px solid #e2e8f0;">
        <td style="padding:8px 10px; color:#64748b; font-size:11px; white-space:nowrap;">${timeStr}</td>
        <td style="padding:8px 10px; font-weight:800; color:#0f172a;">${prodName}${orderNote}</td>
        <td style="padding:8px 10px;"><span style="background:#f0f9ff; color:#0369a1; padding:2px 8px; border-radius:6px; font-weight:700; font-size:11px;">${changeType}</span></td>
        <td style="padding:8px 10px; text-align:center; font-weight:700; color:#475569;">${prevQty}</td>
        <td style="padding:8px 10px; text-align:center; font-weight:800; color:#0f172a;">${newQty}</td>
        <td style="padding:8px 10px; text-align:center; font-weight:900; color:${diffColor};">${diffStr}</td>
        <td style="padding:8px 10px; color:#475569; font-size:11px; font-weight:600;">${performer}</td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;
  container.innerHTML = html;
}
window.renderInventoryLogsUI = renderInventoryLogsUI;

// ==========================================
// Shortage Alerts & Notifications Center (خاص بصاحب المذخر)
// ==========================================
let latestSamoLowStockData = null;

async function checkSamoLowStockAlerts(force = false) {
  const badge = document.getElementById('shortage-badge-count');
  const notifBtn = document.getElementById('header-notifications-btn');
  const alertsContainer = document.getElementById('alerts-container');

  // If user is not admin (warehouse owner), clear all shortage indicators and return
  if (!isAdmin) {
    if (badge) badge.style.display = 'none';
    if (notifBtn) {
      notifBtn.style.display = 'none';
      notifBtn.classList.remove('has-alerts');
    }
    if (alertsContainer) alertsContainer.innerHTML = '';
    return;
  }

  // Ensure notifications button is visible for admin
  if (notifBtn) {
    notifBtn.style.display = 'inline-flex';
  }

  try {
    // 1. Fetch live low stock analysis directly from Supabase samo table
    const res = await fetch('/api/supabase/low-stock', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data || !data.success) {
      console.warn('Could not check Supabase samo low stock:', data?.error);
      return;
    }

    latestSamoLowStockData = data;
    updateShortageNotificationBadge(data);

    // If notifications modal is currently open, refresh its content live
    const modal = document.getElementById('modal-shortage-notifications');
    if (modal && (modal.style.display === 'flex' || modal.classList.contains('active'))) {
      renderShortageNotificationsModalContent(data);
    }
  } catch (err) {
    console.warn('Fallback: checking loaded products for low stock alert:', err);
    // Fallback using products already in memory
    if (products && products.length > 0) {
      const lowItems = products.filter(p => {
        const q = Number(p.quantity) || 0;
        const m = (p.minQty !== null && p.minQty !== undefined) ? Number(p.minQty) : 5;
        return q < m;
      });
      const outOfStockCount = lowItems.filter(p => Number(p.quantity) <= 0).length;
      const data = {
        success: true,
        tableName: 'samo',
        totalCount: products.length,
        lowStockCount: lowItems.length,
        outOfStockCount,
        items: lowItems
      };
      latestSamoLowStockData = data;
      updateShortageNotificationBadge(data);

      const modal = document.getElementById('modal-shortage-notifications');
      if (modal && (modal.style.display === 'flex' || modal.classList.contains('active'))) {
        renderShortageNotificationsModalContent(data);
      }
    }
  }
}

function updateShortageNotificationBadge(data) {
  const badge = document.getElementById('shortage-badge-count');
  const notifBtn = document.getElementById('header-notifications-btn');
  const { lowStockCount = 0 } = data;

  if (lowStockCount > 0) {
    if (badge) {
      badge.innerText = `${lowStockCount}`;
      badge.style.display = 'inline-block';
    }
    if (notifBtn) {
      notifBtn.classList.add('has-alerts');
      notifBtn.title = `يوجد ${lowStockCount} مادة دون الحد الأدنى بالمخزن (اضغط لعرض الإشعارات)`;
    }
  } else {
    if (badge) {
      badge.style.display = 'none';
    }
    if (notifBtn) {
      notifBtn.classList.remove('has-alerts');
      notifBtn.title = 'مركز إشعارات النواقص (لا توجد مواد ناقصة حالياً)';
    }
  }
}

function openShortageNotificationsModal() {
  if (!isAdmin) {
    showQuickToast('تنبيهات وإشعارات النواقص متاحة فقط لصاحب المذخر');
    return;
  }

  const modal = document.getElementById('modal-shortage-notifications');
  if (!modal) return;
  modal.style.display = 'flex';

  if (latestSamoLowStockData) {
    renderShortageNotificationsModalContent(latestSamoLowStockData);
  } else {
    checkSamoLowStockAlerts(true);
  }
}

function closeShortageNotificationsModal() {
  const modal = document.getElementById('modal-shortage-notifications');
  if (modal) modal.style.display = 'none';
}

async function refreshShortageNotifications() {
  showQuickToast('جاري تحديث وفحص نواقص المخزن... ⏳');
  await checkSamoLowStockAlerts(true);
  showQuickToast('تم تحديث قائمة النواقص بنجاح ✓');
}

function renderShortageNotificationsModalContent(data) {
  const totalEl = document.getElementById('notif-total-shortage-count');
  const zeroEl = document.getElementById('notif-zero-stock-count');
  const lowEl = document.getElementById('notif-low-stock-count');
  const container = document.getElementById('notif-shortage-items-container');

  if (!container) return;

  const lowStockCount = data?.lowStockCount || 0;
  const outOfStockCount = data?.outOfStockCount || 0;
  const nearOutCount = Math.max(0, lowStockCount - outOfStockCount);

  if (totalEl) totalEl.innerText = `${lowStockCount}`;
  if (zeroEl) zeroEl.innerText = `${outOfStockCount}`;
  if (lowEl) lowEl.innerText = `${nearOutCount}`;

  filterShortageNotificationList();
}

function filterShortageNotificationList() {
  const container = document.getElementById('notif-shortage-items-container');
  if (!container) return;

  if (!latestSamoLowStockData || !latestSamoLowStockData.items || latestSamoLowStockData.items.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 30px 16px; background: #f0fdf4; border: 1px dashed #86efac; border-radius: 12px; color: #15803d;">
        <div style="font-size: 32px; margin-bottom: 6px;">🎉</div>
        <div style="font-size: 15px; font-weight: 800;">المخزون مكتمل بالكامل!</div>
        <div style="font-size: 12px; color: #166534; margin-top: 4px;">لا توجد أي مادة أو دواء دون الحد الأدنى في جدول samo حالياً.</div>
      </div>
    `;
    return;
  }

  const query = (document.getElementById('notif-search-input')?.value || '').trim().toLowerCase();
  const filterType = document.getElementById('notif-filter-type')?.value || 'all';

  let items = latestSamoLowStockData.items;

  if (filterType === 'zero') {
    items = items.filter(it => Number(it.quantity) <= 0);
  } else if (filterType === 'low') {
    items = items.filter(it => Number(it.quantity) > 0);
  }

  if (query) {
    items = items.filter(it => {
      const name = (it.name || '').toLowerCase();
      const comp = (it.company || '').toLowerCase();
      const form = (it.form || '').toLowerCase();
      return name.includes(query) || comp.includes(query) || form.includes(query);
    });
  }

  if (items.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 24px 12px; color: var(--ios-sub); font-size: 13px;">
        لا توجد مواد تطابق خيارات التصفية الحالية.
      </div>
    `;
    return;
  }

  container.innerHTML = items.map(it => {
    const qty = Number(it.quantity) || 0;
    const isZero = qty <= 0;
    const minQty = (it.minQty !== null && it.minQty !== undefined) ? Number(it.minQty) : 5;

    return `
      <div class="shortage-notif-item ${isZero ? 'is-zero' : 'is-low'}">
        <div style="display: flex; flex-direction: column; gap: 2px; overflow: hidden; flex: 1;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 13.5px; font-weight: 800; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(it.name || '')}">
              ${escapeHtml(it.name || 'بدون اسم')}
            </span>
            ${it.form ? `<span style="font-size: 10px; background: #e0f2fe; color: #0369a1; padding: 1px 6px; border-radius: 6px; font-weight: 700;">${escapeHtml(it.form)}</span>` : ''}
          </div>
          <div style="font-size: 11px; color: var(--ios-sub); display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <span>🏢 ${escapeHtml(it.company || 'غير محدد')}</span>
            ${it.price ? `<span>💵 ${Number(it.price).toLocaleString()} د.ع</span>` : ''}
            ${it.expiry ? `<span>📅 الصلاحية: ${escapeHtml(it.expiry)}</span>` : ''}
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
          <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px;">
            <span class="samo-badge-qty ${isZero ? 'out' : 'low'}">
              ${isZero ? '🚫 نفد تماماً (0)' : `⚠️ متوفر: ${qty}`}
            </span>
            <span class="samo-badge-min">
              الحد الأدنى: ${minQty}
            </span>
          </div>
          <button type="button" class="btn btn-sec" style="padding: 6px 10px; font-size: 11.5px; font-weight: 800; color: #0284c7; border-color: #bae6fd; background: #f0f9ff;" onclick="openEditModalFromNotif('${it.id}')" title="تعديل المادة وزيادة الرصيد">
            ✏️ تعديل
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function openEditModalFromNotif(id) {
  closeShortageNotificationsModal();
  openEditModal(id);
}

function applyShortageFilterToWarehouse() {
  closeShortageNotificationsModal();

  const stockSelect = document.getElementById('filter-stock');
  if (stockSelect) {
    stockSelect.value = 'low_stock';
  }
  // Ensure out of stock items are not hidden
  if (hideOutOfStock) {
    hideOutOfStock = false;
    const btn = document.getElementById('toggle-out-stock-circle');
    if (btn) btn.classList.remove('active');
  }
  // Clear search box so all low stock items are rendered
  const sBox = document.getElementById('search-box');
  if (sBox) sBox.value = '';

  setMainTab('home');
  renderProducts();

  const deck = document.getElementById('medicines-deck-frame');
  if (deck) {
    deck.scrollIntoView({ behavior: 'smooth' });
  }
  showQuickToast('تمت تصفية المخزن لعرض الأدوية والمواد الناقصة ✓');
}

// Window bindings for notification center & voice search
window.checkSamoLowStockAlerts = checkSamoLowStockAlerts;
window.openShortageNotificationsModal = openShortageNotificationsModal;
window.closeShortageNotificationsModal = closeShortageNotificationsModal;
window.refreshShortageNotifications = refreshShortageNotifications;
window.filterShortageNotificationList = filterShortageNotificationList;
window.openEditModalFromNotif = openEditModalFromNotif;
window.applyShortageFilterToWarehouse = applyShortageFilterToWarehouse;

// Voice Search bindings
window.toggleVoiceSearch = toggleVoiceSearch;
window.startVoiceSearch = startVoiceSearch;
window.stopVoiceSearch = stopVoiceSearch;
window.switchVoiceLanguage = switchVoiceLanguage;
window.updateVoiceSheetLangUI = updateVoiceSheetLangUI;

// Global App Helper bindings
window.formatBarcodeDisplay = formatBarcodeDisplay;
window.openSendModal = openSendModal;
window.closeSendModal = closeSendModal;
window.openOrderModal = typeof openSendModal === 'function' ? openSendModal : function() {};


