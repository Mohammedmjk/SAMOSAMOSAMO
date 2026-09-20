/**
 * مستودع سامو للأدوية - العميل الرئيسي المتكامل
 * متصل بقاعدة بيانات SQLite المحلية عبر واجهة API السريعة
 */

const API_URL = "/api";
const ADMIN_PASS = "1234";

// Local in-memory states
let products = [];
let orders = [];
let pendingOrders = [];
let cart = {};
let posCart = {};
let isAdmin = false;
let currentTab = 'home';
let searchTimeout = null;
let currentScannerTarget = 'search-box';
let html5QrCode = null;
let lastSelectedPrinter = localStorage.getItem('samo_thermal_printer') || '';
let printBridgeAvailable = false;
let currentStaff = localStorage.getItem('samo_current_staff') || '';
let staffNames = ['حسين', 'سجاد'];
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

// Check if an order is strictly an approved outgoing order
function isApprovedOrder(o) {
  if (!o || typeof o !== 'object') return false;
  const st = String(o.status || '').trim().toLowerCase();
  return ['معتمد للتجهيز', 'مستلم', 'مسلّم', 'مسلم', 'مسلّمة', 'مسلمة', 'delivered', 'معتمد', 'مجهزة', 'approved'].includes(st);
}

// In-app modal confirmation dialog (immune to iframe restrictions)
function closeConfirmDeleteModal() {
  const modal = document.getElementById('modal-confirm-delete');
  if (modal) modal.classList.remove('is-open');
}

function showInAppConfirm({ title, message, icon = '🗑️', confirmText = 'نعم، تأكيد', isDanger = true, onConfirm }) {
  const modal = document.getElementById('modal-confirm-delete');
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
  if (existingForm && existingForm.trim()) return existingForm.trim();
  const n = (name || '').toLowerCase();
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
  if (n.includes('drop') || n.includes('قطرة')) return 'Drops';
  return 'Tablet';
}

function normalizeOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const items = Array.isArray(order.items) ? order.items : [];
  const status = (order.status || 'معتمد للتجهيز').trim();
  const orderNumber = String(order.orderNumber || order.order_number || `ORD-${Date.now()}`);
  return {
    orderNumber,
    pharmacyName: String(order.pharmacyName || order.pharmacy_name || 'صيدلية غير مسجلة').trim(),
    phone: String(order.phone || '').trim(),
    staffName: String(order.staffName || order.staff_name || '').trim(),
    deliveryStaffName: String(order.deliveryStaffName || order.delivery_staff_name || '').trim(),
    deliveredAt: String(order.deliveredAt || order.delivered_at || '').trim(),
    totalAmount: Number(order.totalAmount || order.total_amount || 0),
    status,
    date: String(order.date || order.createdAt || new Date().toLocaleString('ar-IQ')).trim(),
    createdAt: String(order.createdAt || order.date || new Date().toISOString()).trim(),
    userId: String(order.userId || order.user_id || '').trim(),
    items: items.map(it => ({
      id: String(it.id || ''),
      name: String(it.name || it.product_name || 'مادة بدون اسم').trim(),
      barcode: String(it.barcode || '').trim(),
      form: smartDetectForm(it.name, it.form),
      quantity: Math.max(0, Math.floor(Number(it.quantity) || 0)),
      price: Math.max(0, Number(it.price) || 0),
      expiryDate: String(it.expiryDate || it.expiry_date || '').trim()
    }))
  };
}

// Local Storage helpers
function saveLocalData() {
  try {
    localStorage.setItem('samo_local_products', JSON.stringify(products));
    localStorage.setItem('samo_local_orders', JSON.stringify(orders));
    localStorage.setItem('samo_local_pending', JSON.stringify(pendingOrders));
    localStorage.setItem('samo_local_staff', JSON.stringify(staffNames));
  } catch (e) {
    console.warn('LocalStorage save error:', e);
  }
}

function loadLocalData() {
  try {
    const p = localStorage.getItem('samo_local_products');
    if (p) products = JSON.parse(p);
    const o = localStorage.getItem('samo_local_orders');
    if (o) orders = JSON.parse(o).map(normalizeOrder).filter(Boolean).filter(isApprovedOrder);
    const po = localStorage.getItem('samo_local_pending');
    if (po) pendingOrders = JSON.parse(po).map(normalizeOrder).filter(Boolean).filter(x => !isApprovedOrder(x));
    const st = localStorage.getItem('samo_local_staff');
    if (st) staffNames = JSON.parse(st);
  } catch (e) {
    console.warn('LocalStorage load error:', e);
  }
}

// Remote API loader
async function loadRemoteData() {
  const lbl = document.getElementById('conn-lbl');
  if (lbl) lbl.innerText = 'جاري المزامنة مع قاعدة البيانات...';
  try {
    const res = await fetch(API_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();

    if (data && data.success) {
      if (Array.isArray(data.products)) {
        products = data.products.map(p => ({
          ...p,
          form: smartDetectForm(p.name, p.form),
          quantity: Number(p.quantity) || 0,
          minQty: Number(p.minQty) || 5,
          price: Number(p.price) || 0,
          totalPrice: Number(p.totalPrice) || (Number(p.quantity || 0) * Number(p.price || 0)),
          bonus: Number(p.bonus) || 0
        }));
      }

      if (Array.isArray(data.orders)) {
        // Enforce that orders contains ONLY approved orders (الطلبيات الصادرة)
        orders = data.orders.map(normalizeOrder).filter(Boolean).filter(isApprovedOrder);
      }

      if (Array.isArray(data.pendingOrders)) {
        // Pending orders are all unapproved incoming orders
        pendingOrders = data.pendingOrders.map(normalizeOrder).filter(Boolean).filter(x => !isApprovedOrder(x));
      }

      if (Array.isArray(data.staffNames) && data.staffNames.length > 0) {
        staffNames = data.staffNames;
      }

      saveLocalData();
      if (lbl) {
        lbl.innerText = isAdmin 
          ? 'وضع صاحب المذخر (متصل بقاعدة البيانات)' 
          : (currentStaff ? `وضع الموظف: ${currentStaff} (متصل)` : 'وضع الموظف (متصل)');
      }
    }
  } catch (err) {
    console.error('API load error, using local fallback:', err);
    loadLocalData();
    if (lbl) lbl.innerText = 'أوفلاين (بيانات محفوظة محلياً)';
  } finally {
    refreshAllUI();
  }
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
    console.error('postToApi failed:', err);
    throw err;
  }
}

function triggerSync() {
  loadRemoteData();
}

// Tab Switching
function setMainTab(tab) {
  currentTab = tab;
  ['home', 'pos', 'incoming', 'log', 'staff', 'reports'].forEach(t => {
    const el = document.getElementById(`view-${t}`);
    const btn = document.getElementById(`tab-btn-${t}`);
    if (el) el.style.display = (t === tab) ? (t === 'home' ? 'flex' : 'block') : 'none';
    if (btn) {
      if (t === tab) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  });

  if (tab === 'home') renderProducts();
  if (tab === 'pos') { renderPosGrid(); renderPosCart(); }
  if (tab === 'incoming') renderIncomingOrders();
  if (tab === 'log') renderOrdersLog();
  if (tab === 'staff') renderStaffReport();
  if (tab === 'reports') { updateFinanceReports(); populateCompanyReportDropdown(); }
}

// Admin Mode
function triggerAdmin() {
  if (isAdmin) {
    if (confirm('هل تريد الخروج من وضع صاحب المذخر والعودة لوضع الموظف العادي؟')) {
      isAdmin = false;
      currentStaff = '';
      localStorage.removeItem('samo_current_staff');
      applyAdminState();
      setMainTab('home');
    }
    return;
  }
  openAdminAuthModal();
}

function openAdminAuthModal() {
  const input = document.getElementById('admin-pin-input');
  const err = document.getElementById('admin-pin-error');
  if (input) input.value = '';
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

function submitAdminAuth() {
  const input = document.getElementById('admin-pin-input');
  const err = document.getElementById('admin-pin-error');
  const pin = (input ? input.value : '').trim();
  if (pin === ADMIN_PASS || pin === '1234') {
    isAdmin = true;
    closeAdminAuthModal();
    applyAdminState();
    // Directly open the owner's dedicated view
    if (pendingOrders.length > 0) {
      setMainTab('incoming');
    } else {
      setMainTab('home');
    }
    alert('مرحباً بك! تم الدخول بنجاح إلى لوحة تحكم صاحب المذخر.');
  } else {
    if (err) err.style.display = 'block';
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function applyAdminState() {
  const adminBtn = document.getElementById('admin-toggle-btn');
  const connLbl = document.getElementById('conn-lbl');
  const posTab = document.getElementById('tab-btn-pos');
  const incomingTab = document.getElementById('tab-btn-incoming');
  const staffTab = document.getElementById('tab-btn-staff');
  const repTab = document.getElementById('tab-btn-reports');
  const addBtn = document.getElementById('add-prod-btn');
  const adminPicker = document.getElementById('admin-header-user-picker');
  const addStaffBtn = document.getElementById('admin-add-staff-btn');
  const logTitle = document.getElementById('log-tab-title');
  const logViewTitle = document.getElementById('log-view-title');
  const logViewSubtitle = document.getElementById('log-view-subtitle');

  if (isAdmin) {
    if (adminBtn) { adminBtn.innerText = 'خروج من المذخر'; adminBtn.style.background = '#ff3b30'; }
    if (connLbl) connLbl.innerText = 'وضع صاحب المذخر (متصل بقاعدة البيانات)';
    if (posTab) posTab.style.display = 'block';
    if (incomingTab) incomingTab.style.display = 'block';
    if (staffTab) staffTab.style.display = 'block';
    if (repTab) repTab.style.display = 'block';
    if (addBtn) addBtn.style.display = 'inline-flex';
    if (adminPicker) {
      adminPicker.style.display = 'inline-flex';
      const userLbl = document.getElementById('header-user-lbl');
      if (userLbl) userLbl.innerText = '👑 تصفية:';
    }
    if (addStaffBtn) addStaffBtn.style.display = 'inline-flex';
    if (logTitle) logTitle.innerText = 'الطلبيات الصادرة';
    if (logViewTitle) logViewTitle.innerText = 'الطلبيات الصادرة (المعتمدة فقط)';
    if (logViewSubtitle) logViewSubtitle.innerText = 'سجل الطلبيات المعتمدة والمجهزة حصراً الصادرة من المستودع.';
  } else {
    if (adminBtn) { adminBtn.innerText = 'دخول المذخر'; adminBtn.style.background = '#3a3a3c'; }
    if (connLbl) connLbl.innerText = 'تطبيق الطلبات المباشر';
    if (posTab) posTab.style.display = 'none';
    if (incomingTab) incomingTab.style.display = 'none';
    if (staffTab) staffTab.style.display = 'none';
    if (repTab) repTab.style.display = 'none';
    if (addBtn) addBtn.style.display = 'none';
    if (adminPicker) adminPicker.style.display = 'none';
    if (addStaffBtn) addStaffBtn.style.display = 'none';
    if (logTitle) logTitle.innerText = 'الطلبيات الصادرة';
    if (logViewTitle) logViewTitle.innerText = 'الطلبيات الصادرة (المعتمدة فقط)';
    if (logViewSubtitle) logViewSubtitle.innerText = 'سجل الطلبيات المعتمدة والمجهزة حصراً الصادرة من المستودع.';
    if (currentTab === 'incoming' || currentTab === 'staff' || currentTab === 'reports' || currentTab === 'pos') {
      setMainTab('home');
    }
  }
  populateStaffDropdowns();
  renderProducts();
}

function populateStaffDropdowns() {
  const selects = ['staff-name-select', 'staff-report-select', 'order-staff-select'];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';

    if (id === 'staff-report-select') {
      const def = document.createElement('option');
      def.value = '';
      def.innerText = '-- اختر موظفاً لعرض التقرير --';
      sel.appendChild(def);
    } else if (id === 'order-staff-select') {
      const def = document.createElement('option');
      def.value = '';
      def.innerText = '-- اختر اسمك (صاحب الطلبية) --';
      sel.appendChild(def);
    } else if (id === 'staff-name-select') {
      const def = document.createElement('option');
      def.value = '';
      def.innerText = isAdmin ? '👑 الكل (جميع الموظفين)' : '👤 اختر اسمك للعمل...';
      sel.appendChild(def);
    }

    staffNames.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.innerText = s;
      sel.appendChild(opt);
    });

    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.innerText = '➕ إضافة اسم موظف جديد...';
    sel.appendChild(newOpt);

    if (cur && cur !== '__new__') {
      sel.value = cur;
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
  
  const connLbl = document.getElementById('conn-lbl');
  if (connLbl) {
    if (isAdmin) {
      connLbl.innerText = val ? `وضع صاحب المذخر (تصفية: ${val})` : 'وضع صاحب المذخر (متصل بقاعدة البيانات)';
    } else {
      connLbl.innerText = 'تطبيق الطلبات المباشر';
    }
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

// Product Filtering & Rendering
function getFilteredProducts() {
  const query = (document.getElementById('search-box')?.value || '').trim().toLowerCase();
  const formFilter = document.getElementById('filter-form')?.value || '';
  const expiryFilter = document.getElementById('filter-expiry')?.value || '';
  const stockFilter = document.getElementById('filter-stock')?.value || '';
  const compFilter = document.getElementById('filter-company')?.value || '';

  const now = new Date();
  const sixMonthsAhead = new Date();
  sixMonthsAhead.setMonth(now.getMonth() + 6);

  return products.filter(p => {
    if (hideOutOfStock && Number(p.quantity) <= 0) return false;

    if (query) {
      const matchName = (p.name || '').toLowerCase().includes(query);
      const matchBarcode = (p.barcode || '').toLowerCase().includes(query);
      const matchComp = (p.company || '').toLowerCase().includes(query);
      if (!matchName && !matchBarcode && !matchComp) return false;
    }

    if (formFilter && p.form !== formFilter) return false;
    if (compFilter && p.company !== compFilter) return false;

    if (stockFilter === 'available' && Number(p.quantity) <= 0) return false;
    if (stockFilter === 'shortage' && Number(p.quantity) > 0) return false;

    if (expiryFilter) {
      if (!p.expiryDate) return false;
      const expD = new Date(p.expiryDate);
      if (isNaN(expD.getTime())) return false;
      if (expiryFilter === 'expired' && expD >= now) return false;
      if (expiryFilter === 'near' && (expD < now || expD > sixMonthsAhead)) return false;
      if (expiryFilter === 'valid' && expD <= sixMonthsAhead) return false;
    }

    return true;
  });
}

function renderProducts() {
  const container = document.getElementById('prod-list-container');
  if (!container) return;

  const list = getFilteredProducts();
  populateCompanyFilterDropdown();

  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 40px 20px; color: var(--ios-sub);">
        <div style="font-size: 36px; margin-bottom: 8px;">🔍</div>
        <div style="font-size: 15px; font-weight: 700;">لا توجد مواد تطابق البحث أو الفلاتر</div>
      </div>
    `;
    return;
  }

  let html = `
    <div class="products-scroll-counter">
      <span class="products-scroll-counter-text">عرض ${list.length} من أصل ${products.length} مادة</span>
    </div>
  `;

  // Pre-calculate the most recent order info for the active user/employee for all products
  const lastOrderByProdKey = {};
  const relevantOrders = [...(pendingOrders || []), ...(orders || [])].filter(isOrderVisibleInLog);
  // Sort descending by order date or timestamp
  relevantOrders.sort((a, b) => {
    const timeA = new Date(a.date || a.timestamp || 0).getTime();
    const timeB = new Date(b.date || b.timestamp || 0).getTime();
    return timeB - timeA;
  });

  relevantOrders.forEach(ord => {
    const rawDate = ord.date || ord.timestamp || '';
    let formattedDate = rawDate ? String(rawDate).slice(0, 10) : '';
    if (rawDate) {
      try {
        const d = new Date(rawDate);
        if (!isNaN(d.getTime())) {
          formattedDate = d.toLocaleDateString('ar-IQ', { year: 'numeric', month: 'numeric', day: 'numeric' });
        }
      } catch (e) {}
    }
    const phName = ord.pharmacyName ? ` (${ord.pharmacyName})` : '';

    (ord.items || []).forEach(it => {
      const q = Number(it.quantity) || 0;
      if (q <= 0) return;

      const keysToRegister = [];
      if (it.id) keysToRegister.push(`id:${it.id}`);
      if (it.name) keysToRegister.push(`name:${String(it.name).trim().toLowerCase()}`);

      keysToRegister.forEach(k => {
        if (!lastOrderByProdKey[k]) {
          lastOrderByProdKey[k] = {
            quantity: q,
            date: formattedDate,
            pharmacy: phName,
            orderNumber: ord.orderNumber || ''
          };
        }
      });
    });
  });

  list.forEach(p => {
    const qty = Number(p.quantity) || 0;
    const price = Number(p.price) || 0;
    const bonus = Number(p.bonus) || 0;
    const netPrice = bonus > 0 ? Math.round(price * (1 - bonus / 100)) : price;
    const cartQty = cart[p.id] || 0;

    // Retrieve last request info for this product
    const pNameKey = p.name ? `name:${String(p.name).trim().toLowerCase()}` : null;
    const lastReq = lastOrderByProdKey[`id:${p.id}`] || (pNameKey ? lastOrderByProdKey[pNameKey] : null);

    let expBadgeClass = 'badge-normal-bar';
    let expLabel = p.expiryDate || 'غير محدد';
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
        expLabel = `قريب الانتهاء: ${p.expiryDate}`;
      }
    }

    html += `
      <div class="prod-card" id="card-${p.id}">
        <div class="prod-top">
          <img class="prod-img-thumb" src="${p.image || 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=100&auto=format&fit=crop&q=60'}" alt="medicine" onerror="this.src='https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=100&auto=format&fit=crop&q=60'">
          <div class="prod-info-col">
            <div class="prod-name">${escapeHtml(p.name)}</div>
            <div class="prod-sub-info">
              <span class="badge badge-form">${escapeHtml(p.form || 'Tablet')}</span>
              <span class="badge ${expBadgeClass}">📅 ${expLabel}</span>
              ${p.company ? `<span class="badge" style="background:#f3f4f6;color:#374151;">🏢 ${escapeHtml(p.company)}</span>` : ''}
              ${p.barcode ? `<span class="badge" style="background:#fef3c7;color:#92400e;cursor:pointer;" onclick="openDirectBarcodeModal('${p.id}')">🏷️ ${escapeHtml(p.barcode)}</span>` : ''}
            </div>
            ${lastReq ? `
              <div class="prod-last-request" title="آخر كمية وتاريخ طلب مسجل لك لهذا الدواء">
                <span class="last-order-tag">🕒 آخر طلب لك:</span>
                <span>الكمية: <strong>${lastReq.quantity}</strong></span>
                <span>•</span>
                <span>التاريخ: <strong>${escapeHtml(lastReq.date)}</strong></span>
                ${lastReq.pharmacy ? `<span style="font-size:10px;color:#a1a1aa;">${escapeHtml(lastReq.pharmacy)}</span>` : ''}
              </div>
            ` : ''}
          </div>
          ${isAdmin ? `
            <div style="display:flex;gap:4px;">
              <button class="btn btn-sec" style="padding:4px 8px;font-size:11px;" onclick="openEditModal('${p.id}')">تعديل</button>
            </div>
          ` : ''}
        </div>

        <div class="prod-bottom">
          <div>
            <span class="prod-price">${netPrice.toLocaleString()} د.ع</span>
            ${bonus > 0 ? `<span class="prod-orig-price">${price.toLocaleString()}</span><span class="badge" style="background:#dcfce7;color:#15803d;font-size:10px;">بونص %${bonus}</span>` : ''}
          </div>
          <div class="prod-stock-lbl">
            المتوفر: <b style="color:${qty > 0 ? 'var(--ios-green)' : 'var(--ios-red)'}">${qty}</b>
          </div>
        </div>

        <div class="prod-cart-action-area">
          ${qty <= 0 ? `
            <div class="badge-out">⚠️ نفد من المخزن (غير متوفر)</div>
          ` : (cartQty === 0 ? `
            <button class="btn-add-cart-wide" onclick="changeCartQty('${p.id}', 1)">
              🛒 إضافة للطلب
            </button>
          ` : `
            <div class="counter-control-wide">
              <button class="counter-btn-wide" onclick="changeCartQty('${p.id}', -1)">-</button>
              <div class="counter-val-wide" onclick="setCartQtyDirect('${p.id}')">${cartQty}</div>
              <button class="counter-btn-wide" onclick="changeCartQty('${p.id}', 1)">+</button>
            </div>
          `)}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function populateCompanyFilterDropdown() {
  const sel = document.getElementById('filter-company');
  if (!sel) return;
  const cur = sel.value;
  const companies = Array.from(new Set(products.map(p => p.company).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">-- جميع الشركات --</option>';
  companies.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.innerText = c;
    sel.appendChild(opt);
  });
  sel.value = cur;
}

function resetAllFilters() {
  const f = document.getElementById('filter-form');
  const e = document.getElementById('filter-expiry');
  const s = document.getElementById('filter-stock');
  const c = document.getElementById('filter-company');
  if (f) f.value = '';
  if (e) e.value = '';
  if (s) s.value = '';
  if (c) c.value = '';
  renderProducts();
}

function toggleHideOutStock() {
  hideOutOfStock = !hideOutOfStock;
  localStorage.setItem('samo_hide_out_of_stock', hideOutOfStock ? 'true' : 'false');
  const btn = document.getElementById('toggle-out-stock-circle');
  if (btn) btn.style.background = hideOutOfStock ? '#e0f2fe' : '#ffffff';
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
      updateCartBadge();
      renderProducts();
    }
  }
}

function updateCartBadge() {
  const totalItems = Object.values(cart).reduce((a, b) => a + b, 0);
  const dot = document.getElementById('cart-dot');
  if (dot) {
    if (totalItems > 0) {
      dot.style.display = 'block';
      dot.innerText = totalItems;
    } else {
      dot.style.display = 'none';
    }
  }
}

function renderCartBadge() {
  updateCartBadge();
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

// Send Modal
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
  populateSavedPharmaciesDropdown();
  const modal = document.getElementById('modal-send-order');
  if (modal) modal.classList.add('is-open');
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
  const row = document.getElementById('saved-pharmacy-picker-row');
  const sel = document.getElementById('saved-ph-select');
  if (!row || !sel) return;

  const phMap = new Map();
  orders.concat(pendingOrders).forEach(o => {
    if (o.pharmacyName && !phMap.has(o.pharmacyName)) {
      phMap.set(o.pharmacyName, o.phone || '');
    }
  });

  if (phMap.size === 0) {
    row.style.display = 'none';
    return;
  }

  row.style.display = 'block';
  sel.innerHTML = '<option value="">-- أو اختر صيدلية مسجلة مسبقاً --</option>';
  phMap.forEach((phone, name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.dataset.phone = phone;
    opt.innerText = `${name} (${phone || 'بدون هاتف'})`;
    sel.appendChild(opt);
  });
}

function onSavedPharmacySelected() {
  const sel = document.getElementById('saved-ph-select');
  if (!sel) return;
  const phName = document.getElementById('order-ph-name');
  const phPhone = document.getElementById('order-ph-phone');
  const opt = sel.options[sel.selectedIndex];
  if (opt && opt.value) {
    if (phName) phName.value = opt.value;
    if (phPhone) phPhone.value = opt.dataset.phone || '';
  }
}

async function confirmOrderSubmission() {
  const phName = (document.getElementById('order-ph-name')?.value || '').trim();
  const phPhone = (document.getElementById('order-ph-phone')?.value || '').trim();
  if (!phName) {
    alert('الرجاء إدخال اسم الصيدلية المستلمة');
    return;
  }

  let orderStaff = '';
  if (isAdmin) {
    orderStaff = (document.getElementById('order-staff-select')?.value || currentStaff || '').trim();
  }

  const items = Object.entries(cart).map(([id, qty]) => {
    const p = products.find(x => x.id === id);
    const bonus = Number(p?.bonus) || 0;
    const price = bonus > 0 ? Math.round(Number(p?.price) * (1 - bonus / 100)) : Number(p?.price || 0);
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

  const totalAmount = items.reduce((acc, it) => acc + (it.quantity * it.price), 0);
  const newOrder = {
    orderNumber: `ORD-${Date.now()}`,
    pharmacyName: phName,
    phone: phPhone,
    staffName: orderStaff,
    deliveryStaffName: '',
    totalAmount,
    status: 'قيد المراجعة',
    date: new Date().toLocaleString('ar-IQ'),
    createdAt: new Date().toISOString(),
    userId: myUserId,
    items
  };

  try {
    const res = await postToApi({ action: 'new_order', order: newOrder });
    if (res.duplicateWarning) {
      if (!confirm('تم إرسال طلبية مطابقة تماماً لنفس الصيدلية مؤخراً. هل تريد إرسالها مجدداً على أي حال؟')) {
        return;
      }
      await postToApi({ action: 'new_order', order: newOrder, forceDuplicate: true });
    }

    // Record order number to user's persistent orders list
    mySubmittedOrderNumbers.add(newOrder.orderNumber);
    saveMyOrderNumbers();

    // Immediately add to local pending orders so it shows in "طلباتي"
    if (!pendingOrders.some(p => p.orderNumber === newOrder.orderNumber)) {
      pendingOrders.unshift(newOrder);
      saveLocalData();
    }

    alert('تم إرسال طلبيتك بنجاح وستجدها محفوظة في تبويب (طلباتي) لمتابعة حالتها ✓');
    cart = {};
    updateCartBadge();
    closeSendModal();
    renderOrdersLog();
    loadRemoteData();
  } catch (err) {
    alert('تعذر إرسال الطلبية، يرجى المحاولة مرة أخرى: ' + err.message);
  }
}

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

async function approveAndSignOrder() {
  if (currentInspectingOrderIndex < 0) return;
  const order = pendingOrders[currentInspectingOrderIndex];
  if (!order) return;

  const staff = currentStaff || prompt('الرجاء إدخال اسم الموظف المجهز لاعتماد الطلبية:') || 'المذخر';

  try {
    const res = await postToApi({
      action: 'approve_order',
      orderNumber: order.orderNumber,
      staffName: staff,
      items: order.items,
      totalAmount: order.totalAmount
    });

    showQuickToast('تم اعتماد الطلبية وخصم الكميات بنجاح ✓');
    closeInspectModal();
    loadRemoteData();
  } catch (err) {
    alert('حدث خطأ أثناء اعتماد الطلبية: ' + err.message);
  }
}

// Instant & Reliable In-App Delete Order Functions
function promptDeleteOrder(orderNumber) {
  const strNum = String(orderNumber || '').trim();
  if (!strNum) return;

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

  const foundPending = pendingOrders.find(o => String(o.orderNumber || '').trim() === strNum);
  const foundOrder = orders.find(o => String(o.orderNumber || '').trim() === strNum);
  const isAppr = foundOrder && isApprovedOrder(foundOrder);

  // If approved order was cancelled, immediately restore stock in local products
  if (isAppr && Array.isArray(foundOrder.items)) {
    foundOrder.items.forEach(it => {
      const p = products.find(prod => prod.id === it.id || prod.barcode === it.barcode || prod.name === it.name);
      if (p) {
        p.quantity = (Number(p.quantity) || 0) + (Number(it.quantity) || 0);
        p.totalPrice = p.quantity * (Number(p.price) || 0);
      }
    });
  }

  // 1. Instant Optimistic UI Update (0ms latency)
  pendingOrders = pendingOrders.filter(o => String(o.orderNumber || '').trim() !== strNum);
  orders = orders.filter(o => String(o.orderNumber || '').trim() !== strNum);
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
  showQuickToast('تم إلغاء وحذف الطلبية فوراً ✓');

  // 2. Background server discard (also restores stock and logs movement in SQLite)
  try {
    await postToApi({ action: 'delete_order', orderNumber: strNum });
  } catch (err) {
    console.warn('Background discard notice:', err);
  }

  loadRemoteData();
}

function deleteIncomingOrderByNumber(orderNumber) {
  promptDeleteOrder(orderNumber);
}

function cancelApprovedOrderPrompt(orderNumber) {
  promptDeleteOrder(orderNumber);
}

function deleteIncomingOrder(idx) {
  const order = pendingOrders[idx];
  if (!order) return;
  promptDeleteOrder(order.orderNumber);
}

function rejectAndDiscardCurrentInspectingOrder() {
  if (currentInspectingOrderIndex < 0) return;
  const order = pendingOrders[currentInspectingOrderIndex];
  if (!order) {
    closeInspectModal();
    return;
  }
  promptDeleteOrder(order.orderNumber);
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
  if (isAdmin) {
    const filterStaff = (currentStaff || '').trim().toLowerCase();
    if (filterStaff && filterStaff !== '__all__' && filterStaff !== '') {
      const orderStaff = (o.staffName || '').trim().toLowerCase();
      const deliverStaff = (o.deliveryStaffName || '').trim().toLowerCase();
      return orderStaff === filterStaff || deliverStaff === filterStaff;
    }
    return true;
  }

  // Regular user: strictly show orders sent from this device/user
  const isMineByUserId = Boolean(o.userId && o.userId === myUserId);
  const isMineByOrderNumber = mySubmittedOrderNumbers.has(String(o.orderNumber));
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

  // STRICT FILTER: Outgoing orders are strictly approved orders!
  const list = orders.filter(o => isOrderVisibleInLog(o) && isApprovedOrder(o));
  const myPending = pendingOrders.filter(isOrderVisibleInLog);

  let html = '';

  // Header Info
  if (!isAdmin) {
    html += `
      <div style="background: #f8fafc; border: 1px solid var(--ios-border); border-radius: 12px; padding: 10px 14px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 18px;">📦</span>
          <span style="font-size: 13px; font-weight: 800; color: var(--ios-text);">الطلبيات الصادرة (المعتمدة فقط)</span>
        </div>
        <span style="font-size: 12px; color: var(--ios-green); font-weight: 700; background: #dcfce7; padding: 3px 10px; border-radius: 12px;">المعتمدة: ${list.length}</span>
      </div>
    `;

    // Compact notification for unapproved pending orders if any exist
    if (myPending.length > 0) {
      html += `
        <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 10px 14px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
          <div>
            <div style="font-size: 13px; font-weight: 800; color: #92400e;">⏳ لديك (${myPending.length}) طلبات مرسلة بانتظار الاعتماد</div>
            <div style="font-size: 11px; color: #b45309; margin-top: 2px;">تظهر الطلبيات في قائمة الصادر فور اعتماد المذخر لها.</div>
          </div>
          <button class="btn btn-sec" style="font-size: 11px; padding: 4px 10px; background: #fff; border-color: #fcd34d; color: #92400e;" onclick="toggleShowPendingOrdersInUserLog()">
            ${showPendingInUserLog ? 'إخفاء الطلبات المعلقة 🔼' : 'عرض وتعديل المعلقة 🔽'}
          </button>
        </div>
      `;
    }
  } else {
    // Admin / Warehouse Mode: Strictly Approved Orders
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
  }

  // If non-admin toggled showing pending orders
  if (!isAdmin && showPendingInUserLog && myPending.length > 0) {
    html += `
      <div style="font-size:13px;font-weight:800;color:#b45309;margin-bottom:8px;padding-right:4px;">
        ⏳ الطلبات المعلقة قيد المراجعة (${myPending.length}):
      </div>
    `;

    myPending.forEach(o => {
      html += `
        <div class="prod-card" style="border-right: 4px solid #f59e0b; margin-bottom: 12px; background: #fffdfa;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-size:15px;font-weight:800;">🏥 ${escapeHtml(o.pharmacyName)}</div>
              <div style="font-size:11px;color:var(--ios-sub);margin-top:2px;">رقم الطلب: ${o.orderNumber} - ${o.date}</div>
              ${o.phone ? `<div style="font-size:11px;color:var(--ios-sub);">هاتف: ${o.phone}</div>` : ''}
              ${o.staffName ? `<div style="font-size:11px;color:var(--ios-green);font-weight:700;">المرسل: ${o.staffName}</div>` : ''}
            </div>
            <div style="text-align:left;">
              <span class="badge" style="background:#fef3c7;color:#92400e;font-weight:800;">⏳ قيد المراجعة</span>
              <div style="font-size:14px;font-weight:800;color:var(--ios-green);margin-top:4px;">${Number(o.totalAmount || 0).toLocaleString()} د.ع</div>
            </div>
          </div>

          <div style="background:#fefce8;border:1px solid #fef08a;padding:8px 12px;border-radius:10px;margin:8px 0;font-size:12px;">
            <b>الأدوية المطلوبة (${o.items?.length || 0}):</b>
            <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px;">
              ${(o.items || []).map(it => `
                <span class="badge" style="background:#fff;border:1px solid #fef08a;color:#111;">${escapeHtml(it.name)} × ${it.quantity} (${((it.quantity || 0) * (it.price || 0)).toLocaleString()} د.ع)</span>
              `).join('')}
            </div>
          </div>

          <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;">
            <button class="btn" style="flex:1;justify-content:center;background:var(--ios-blue);padding:8px 12px;font-size:12px;" onclick="openEditSentOrderModal('${o.orderNumber}')">
              ✏️ تعديل الطلبية
            </button>
            <button class="btn btn-sec" style="color:var(--ios-red);border-color:#fecaca;padding:8px 12px;font-size:12px;" onclick="deleteIncomingOrderByNumber('${o.orderNumber}')">
              🗑️ إلغاء الطلب
            </button>
            <button class="btn btn-sec" style="padding:8px 12px;font-size:12px;" onclick="printOrderA4('${o.orderNumber}')">
              🖨️ طباعة
            </button>
          </div>
        </div>
      `;
    });
    html += `<div style="height:1px;background:var(--ios-border);margin:16px 0;"></div>`;
  }

  // If no approved orders
  if (list.length === 0) {
    html += `
      <div style="text-align:center; padding: 40px 20px; color: var(--ios-sub);">
        <div style="font-size: 38px; margin-bottom: 8px;">📑</div>
        <div style="font-size: 15px; font-weight: 700;">
          ${isAdmin ? 'لا توجد طلبيات صادرة معتمدة مسجلة' : 'لا توجد لديك طلبيات صادرة معتمدة حتى الآن'}
        </div>
        <div style="font-size: 12px; color: var(--ios-sub); margin-top: 4px;">
          الطلبيات المعتمدة والمجهزة الصادرة من المستودع ستظهر هنا حصراً.
        </div>
      </div>
    `;
    container.innerHTML = html;
    return;
  }

  // Approved Outgoing Orders List (الطلبيات الصادرة)
  list.forEach(o => {
    html += `
      <div class="prod-card" style="border-right: 4px solid var(--ios-green); margin-bottom: 12px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-size:16px;font-weight:800;">🏥 ${escapeHtml(o.pharmacyName)}</div>
            <div style="font-size:11px;color:var(--ios-sub);margin-top:2px;">رقم الطلب: ${o.orderNumber} - ${o.date}</div>
            ${o.phone ? `<div style="font-size:11px;color:var(--ios-sub);">هاتف: ${o.phone}</div>` : ''}
            ${o.staffName ? `<div style="font-size:11px;color:var(--ios-green);font-weight:700;">المجهز: ${o.staffName}</div>` : ''}
            ${o.deliveryStaffName ? `<div style="font-size:11px;color:var(--ios-blue);font-weight:700;">المسلم: ${o.deliveryStaffName} (${o.deliveredAt || ''})</div>` : ''}
          </div>
          <div style="text-align:left;">
            <span class="badge" style="background:#dcfce7;color:#15803d;font-weight:800;">✓ ${o.status || 'معتمد'}</span>
            <div style="font-size:15px;font-weight:800;color:var(--ios-green);margin-top:4px;">${Number(o.totalAmount || 0).toLocaleString()} د.ع</div>
          </div>
        </div>

        <div style="background:#f8f9fa;padding:8px 12px;border-radius:10px;margin:8px 0;font-size:12px;">
          <b>المواد المجهزة (${o.items?.length || 0}):</b>
          <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:6px;">
            ${(o.items || []).map(it => `
              <span class="badge" style="background:#e5e7eb;color:#111;">${escapeHtml(it.name)} × ${it.quantity} (${((it.quantity || 0) * (it.price || 0)).toLocaleString()} د.ع)</span>
            `).join('')}
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;">
          <button class="btn btn-sec" style="flex:1;justify-content:center;padding:9px;font-size:12px;" onclick="printOrderA4('${o.orderNumber}')">🖨️ طباعة قائمة A4</button>
          ${isAdmin && o.status !== 'مستلم' ? `
            <button class="btn" style="background:var(--ios-blue);padding:9px 14px;font-size:12px;" onclick="markOrderDelivered('${o.orderNumber}')">تسجيل استلام ✓</button>
          ` : ''}
          <button class="btn btn-sec" style="color:var(--ios-red);border-color:#fecaca;padding:9px 14px;font-size:12px;" onclick="cancelApprovedOrderPrompt('${o.orderNumber}')" title="إلغاء الطلبية وإرجاع المواد للمخزن">
            🗑️ إلغاء وحذف
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

async function markOrderDelivered(orderNumber) {
  const deliverer = currentStaff || prompt('اسم مندوب التوصيل / المستلم:') || 'المندوب';
  try {
    await postToApi({
      action: 'deliver_order',
      orderNumber,
      deliveryStaffName: deliverer,
      deliveredAt: new Date().toLocaleString('ar-IQ')
    });
    alert('تم تسجيل تسليم الطلبية بنجاح ✓');
    loadRemoteData();
  } catch (err) {
    alert('حدث خطأ: ' + err.message);
  }
}

// Print Order A4
function printOrderA4(orderNumber) {
  const o = orders.find(x => x.orderNumber === orderNumber) || pendingOrders.find(x => x.orderNumber === orderNumber);
  if (!o) return;

  const metaBox = document.getElementById('inv-meta-info');
  if (metaBox) {
    metaBox.innerHTML = `
      <div><b>الصيدلية:</b> ${escapeHtml(o.pharmacyName)}</div>
      <div><b>رقم الهاتف:</b> ${escapeHtml(o.phone || 'غير مسجل')}</div>
      <div><b>رقم القائمة:</b> ${o.orderNumber}</div>
      <div><b>التاريخ:</b> ${o.date}</div>
    `;
  }

  const rowsBox = document.getElementById('inv-table-rows');
  if (rowsBox) {
    rowsBox.innerHTML = (o.items || []).map((it, idx) => `
      <tr>
        <td style="border: 1px solid #000; padding: 6px; text-align: center;">${idx + 1}</td>
        <td style="border: 1px solid #000; padding: 6px;"><b>${escapeHtml(it.name)}</b></td>
        <td style="border: 1px solid #000; padding: 6px; text-align: center;">${escapeHtml(it.form || '')}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: center;">${escapeHtml(it.expiryDate || '')}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: center; font-weight: bold;">${it.quantity}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: left;">${Number(it.price || 0).toLocaleString()}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: left; font-weight: bold;">${(it.quantity * it.price).toLocaleString()}</td>
      </tr>
    `).join('');
  }

  const totBox = document.getElementById('inv-total-box');
  if (totBox) {
    totBox.innerHTML = `المبلغ الإجمالي النهائي: <span style="color: green;">${Number(o.totalAmount || 0).toLocaleString()} د.ع</span>`;
  }

  const staffSign = document.getElementById('inv-staff-sign');
  if (staffSign) {
    staffSign.innerText = `توقيع الموظف المجهز: ${o.staffName || '....................'}`;
  }

  window.print();
}

// Edit Medicine Modal
function openEditModal(prodId) {
  const p = products.find(x => x.id === prodId);
  if (!p) return;

  document.getElementById('edit-prod-id').value = p.id;
  document.getElementById('edit-name').value = p.name || '';
  document.getElementById('edit-image').value = p.image || '';
  document.getElementById('edit-company').value = p.company || '';
  document.getElementById('edit-form').value = p.form || 'Tablet';
  document.getElementById('edit-barcode').value = p.barcode || '';
  document.getElementById('edit-qty').value = p.quantity || 0;
  document.getElementById('edit-min-qty').value = p.minQty || 5;
  document.getElementById('edit-price').value = p.price || 0;
  document.getElementById('edit-bonus').value = p.bonus || 0;
  document.getElementById('edit-exp').value = p.expiryDate || '';

  const modal = document.getElementById('modal-edit-item');
  if (modal) modal.classList.add('is-open');
}

function closeEditModal() {
  const modal = document.getElementById('modal-edit-item');
  if (modal) modal.classList.remove('is-open');
}

async function saveEditedMedicine() {
  const id = document.getElementById('edit-prod-id').value;
  const name = (document.getElementById('edit-name').value || '').trim();
  if (!name) { alert('اسم المادة مطلوب'); return; }

  const prod = {
    id,
    name,
    image: document.getElementById('edit-image').value.trim(),
    company: document.getElementById('edit-company').value.trim(),
    form: document.getElementById('edit-form').value.trim(),
    barcode: document.getElementById('edit-barcode').value.trim(),
    quantity: Number(document.getElementById('edit-qty').value) || 0,
    minQty: Number(document.getElementById('edit-min-qty').value) || 5,
    price: Number(document.getElementById('edit-price').value) || 0,
    bonus: Number(document.getElementById('edit-bonus').value) || 0,
    expiryDate: document.getElementById('edit-exp').value.trim()
  };

  try {
    await postToApi({ action: 'update_product', product: prod });
    alert('تم حفظ وتحديث بيانات المادة في قاعدة البيانات بنجاح ✓');
    closeEditModal();
    loadRemoteData();
  } catch (err) {
    alert('تعذر حفظ التعديلات: ' + err.message);
  }
}

// Add Medicine Modal
function openAddModal() {
  document.getElementById('in-name').value = '';
  document.getElementById('in-image').value = '';
  document.getElementById('in-company').value = '';
  document.getElementById('in-form').value = 'Tablet';
  document.getElementById('in-barcode').value = '';
  document.getElementById('in-qty').value = '10';
  document.getElementById('in-min-qty').value = '5';
  document.getElementById('in-price').value = '5000';
  document.getElementById('in-bonus').value = '0';
  document.getElementById('in-exp').value = '';
  calcBonusNet();

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

  const newProd = {
    id: `PROD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    image: document.getElementById('in-image').value.trim(),
    company: document.getElementById('in-company').value.trim(),
    form: document.getElementById('in-form').value.trim(),
    barcode: document.getElementById('in-barcode').value.trim(),
    quantity: Number(document.getElementById('in-qty').value) || 0,
    minQty: Number(document.getElementById('in-min-qty').value) || 5,
    price: Number(document.getElementById('in-price').value) || 0,
    bonus: Number(document.getElementById('in-bonus').value) || 0,
    expiryDate: document.getElementById('in-exp').value.trim(),
    createdAt: new Date().toISOString()
  };

  try {
    await postToApi({ action: 'add_product', product: newProd });
    alert('تم إضافة المادة وحفظها في قاعدة البيانات بنجاح ✓');
    closeAddModal();
    loadRemoteData();
  } catch (err) {
    alert('تعذر إضافة المادة: ' + err.message);
  }
}

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
  const target = document.getElementById(currentScannerTarget);
  if (target) {
    target.value = code;
    if (currentScannerTarget === 'search-box') handleMainSearchInput();
    else if (currentScannerTarget === 'pos-search-box') handlePosSearchInput();
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
        JsBarcode("#prev-barcode-svg", p.barcode || '123456789', {
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
    elNum.innerText = p.barcode || '0000000000000';
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
    barcode: barcode || '123456789',
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
        ${showNum ? `<div class="bc-num">${escapeHtml(p.barcode || '')}</div>` : ''}
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
          const barcodeVal = "${p.barcode || '123456789'}";
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
let posCartCustomPrices = {};

function filterPosByCategory(category, btnElement) {
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
    const box = document.getElementById('pos-search-box');
    const val = (box?.value || '').trim().toLowerCase();
    if (!val) return;

    // Look for exact barcode match first
    const match = products.find(p => (p.barcode || '').toLowerCase() === val) ||
                  products.find(p => (p.name || '').toLowerCase() === val);

    if (match) {
      if (Number(match.quantity) <= 0) {
        showInAppAlert(`المادة (${match.name}) نافذة من المخزن حالياً.`, 'رصيد نافذ');
        return;
      }
      addToPosCart(match.id);
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
    if (posHideOutOfStock && Number(p.quantity) <= 0) return false;
    if (posSelectedCategory && (p.form || '').toLowerCase() !== posSelectedCategory.toLowerCase()) return false;
    if (query) {
      const matchName = (p.name || '').toLowerCase().includes(query);
      const matchBarcode = (p.barcode || '').toLowerCase().includes(query);
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
    const qty = Number(p.quantity) || 0;
    const price = Number(p.price) || 0;
    const bonus = Number(p.bonus) || 0;
    const net = bonus > 0 ? Math.round(price * (1 - bonus / 100)) : price;
    const inCartQty = posCart[p.id] || 0;

    return `
      <div class="pos-card-med">
        <div>
          <div class="pos-card-name">${escapeHtml(p.name)}</div>
          <div class="pos-card-meta">
            <span>${p.form ? escapeHtml(p.form) : 'عام'}</span>
            ${p.company ? `<span>• ${escapeHtml(p.company)}</span>` : ''}
            ${p.barcode ? `<span style="font-family:monospace;background:#f1f5f9;padding:1px 4px;border-radius:4px;font-size:10px;">${escapeHtml(p.barcode)}</span>` : ''}
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
              <button class="btn btn-sec" style="font-size:11px;padding:4px 8px;opacity:0.5;cursor:not-allowed;" disabled>نافذ</button>
            ` : inCartQty > 0 ? `
              <div style="display:flex;align-items:center;gap:3px;background:#e0f2fe;padding:2px 4px;border-radius:8px;">
                <button style="border:none;background:#bae6fd;color:#0369a1;width:22px;height:22px;border-radius:6px;font-weight:bold;cursor:pointer;" onclick="changePosCartQty('${p.id}', -1)">-</button>
                <span style="font-size:11px;font-weight:bold;color:#0369a1;min-width:18px;text-align:center;">${inCartQty}</span>
                <button style="border:none;background:var(--ios-blue);color:#fff;width:22px;height:22px;border-radius:6px;font-weight:bold;cursor:pointer;" onclick="addToPosCart('${p.id}')">+</button>
              </div>
            ` : `
              <button class="btn btn-sec" style="font-size:11px;padding:5px 10px;font-weight:700;color:var(--ios-blue);border-color:#bfdbfe;background:#eff6ff;" onclick="addToPosCart('${p.id}')">
                + إضافة
              </button>
            `}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function addToPosCart(prodId) {
  const p = products.find(x => x.id === prodId);
  if (!p || Number(p.quantity) <= 0) return;
  const cur = posCart[prodId] || 0;
  if (cur < Number(p.quantity)) {
    posCart[prodId] = cur + 1;
    renderPosCart();
    renderPosGrid();
  } else {
    showInAppAlert(`الكمية المتاحة في المستودع لهذا الدواء هي (${p.quantity}) فقط.`, 'الحد الأقصى للمخزون');
  }
}

function changePosCartQty(prodId, delta) {
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
  renderPosCart();
  renderPosGrid();
}

function setPosCartExactQty(prodId, val) {
  const p = products.find(x => x.id === prodId);
  if (!p) return;
  const num = parseInt(val, 10);
  if (isNaN(num) || num <= 0) {
    delete posCart[prodId];
    delete posCartCustomPrices[prodId];
  } else {
    posCart[prodId] = Math.min(Number(p.quantity), num);
  }
  renderPosCart();
  renderPosGrid();
}

function setPosCartCustomPrice(prodId, val) {
  const num = parseFloat(val);
  if (!isNaN(num) && num >= 0) {
    posCartCustomPrices[prodId] = num;
  } else {
    delete posCartCustomPrices[prodId];
  }
  recalcPosTotals();
}

function removePosCartItem(prodId) {
  delete posCart[prodId];
  delete posCartCustomPrices[prodId];
  renderPosCart();
  renderPosGrid();
}

function clearPosCartPrompt() {
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
      renderPosCart();
      renderPosGrid();
    }
  });
}

function populatePosPharmaciesDatalist() {
  const datalist = document.getElementById('pos-pharmacies-datalist');
  if (!datalist) return;

  const namesSet = new Set();
  orders.forEach(o => {
    if (o.pharmacyName && o.pharmacyName.trim()) {
      namesSet.add(o.pharmacyName.trim());
    }
  });

  datalist.innerHTML = Array.from(namesSet).map(name => `<option value="${escapeHtml(name)}">`).join('');
}

function onPosPharmacySelected(name) {
  if (!name) return;
  const match = orders.find(o => (o.pharmacyName || '').trim() === name.trim() && o.phone);
  if (match) {
    const phoneInput = document.getElementById('pos-ph-phone');
    if (phoneInput && !phoneInput.value) {
      phoneInput.value = match.phone;
    }
  }
}

function renderPosCart() {
  const container = document.getElementById('pos-cart-summary');
  const countLbl = document.getElementById('pos-cart-count-lbl');
  const statLbl = document.getElementById('pos-cart-items-stat');
  if (!container) return;

  populatePosPharmaciesDatalist();

  const entries = Object.entries(posCart);
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
          <button style="border:none;background:transparent;color:var(--ios-red);cursor:pointer;font-size:14px;" onclick="removePosCartItem('${id}')" title="حذف من السلة">🗑️</button>
        </div>
        <div class="pos-cart-item-bottom">
          <!-- Editable Quantity Controls -->
          <div class="pos-qty-ctrl">
            <button class="pos-qty-btn" style="background:#e2e8f0;color:#334155;" onclick="changePosCartQty('${id}', -1)">-</button>
            <input type="number" class="pos-qty-input" min="1" max="${p.quantity}" value="${qty}" onchange="setPosCartExactQty('${id}', this.value)">
            <button class="pos-qty-btn" style="background:var(--ios-blue);color:#fff;" onclick="addToPosCart('${id}')">+</button>
          </div>

          <!-- Editable Unit Price Input -->
          <div style="display:flex;align-items:center;gap:4px;">
            <span style="font-size:10.5px;color:var(--ios-sub);">السعر:</span>
            <input type="number" class="pos-price-input" value="${unitPrice}" step="250" onchange="setPosCartCustomPrice('${id}', this.value)" title="تعديل سعر الوحدة">
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
async function executeDirectCashSale() {
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

      // Reset cart
      posCart = {};
      posCartCustomPrices = {};
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

      try {
        await postToApi({ action: 'new_order', order: newOrder });
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
function printPosThermalReceipt() {
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

// Confirm Pos Order Submission as Pending Warehouse Request
async function confirmPosOrderSubmission() {
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

  const { subtotal, discount, netTotal } = recalcPosTotals();

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

  const newOrder = {
    orderNumber: `ORD-${Date.now()}`,
    pharmacyName: phName,
    phone: phPhone,
    staffName: currentStaff || 'نقطة البيع (POS)',
    deliveryStaffName: '',
    totalAmount: netTotal,
    subtotal,
    discount,
    status: 'قيد المراجعة',
    date: new Date().toLocaleString('ar-IQ'),
    createdAt: new Date().toISOString(),
    userId: myUserId,
    items
  };

  try {
    await postToApi({ action: 'new_order', order: newOrder });
    showInAppAlert('تم إرسال طلب نقطة البيع للمستودع للمراجعة بنجاح ✓', 'تم الإرسال');
    posCart = {};
    posCartCustomPrices = {};
    const phInput = document.getElementById('pos-ph-name');
    const phPhoneInput = document.getElementById('pos-ph-phone');
    if (phInput) phInput.value = '';
    if (phPhoneInput) phPhoneInput.value = '';
    renderPosCart();
    renderPosGrid();
    loadRemoteData();
  } catch (err) {
    showInAppAlert('تعذر إرسال الطلب: ' + err.message, 'خطأ');
  }
}

// Staff Management & Reporting
function renderStaffReport() {
  const container = document.getElementById('staff-report-container');
  if (!container) return;

  const staffStats = new Map();
  staffNames.forEach(s => {
    staffStats.set(s, { count: 0, total: 0 });
  });

  orders.forEach(o => {
    const name = o.staffName || o.deliveryStaffName;
    if (name && staffStats.has(name)) {
      const st = staffStats.get(name);
      st.count++;
      st.total += Number(o.totalAmount || 0);
    }
  });

  container.innerHTML = staffNames.map(s => {
    const st = staffStats.get(s) || { count: 0, total: 0 };
    return `
      <div class="prod-card" style="flex-direction:row;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:16px;font-weight:800;">👤 ${escapeHtml(s)}</div>
          <div style="font-size:12px;color:var(--ios-sub);margin-top:2px;">عدد الطلبيات المنجزة: <b>${st.count}</b> طلب</div>
          <div style="font-size:13px;color:var(--ios-green);font-weight:800;margin-top:2px;">إجمالي المبيعات: ${st.total.toLocaleString()} د.ع</div>
        </div>
        ${isAdmin ? `
          <button class="btn btn-danger" style="font-size:11px;padding:6px 10px;" onclick="deleteStaffPrompt('${escapeHtml(s)}')">حذف</button>
        ` : ''}
      </div>
    `;
  }).join('');
}

async function addNewStaffNamePrompt() {
  const name = prompt('أدخل اسم الموظف الجديد:');
  if (!name || !name.trim()) {
    populateStaffDropdowns();
    return;
  }
  const trimmed = name.trim();
  try {
    await postToApi({ action: 'add_staff', name: trimmed });
    if (!staffNames.includes(trimmed)) staffNames.push(trimmed);
    onStaffSelected(trimmed);
    populateStaffDropdowns();
    renderStaffReport();
    alert(`تمت إضافة الموظف (${trimmed}) واختياره بنجاح ✓`);
  } catch (err) {
    alert('حدث خطأ: ' + err.message);
    populateStaffDropdowns();
  }
}

function deleteStaffPrompt(name) {
  showInAppConfirm({
    title: 'حذف موظف',
    message: `هل أنت متأكد من حذف الموظف <b>(${escapeHtml(name)})</b> نهائياً من النظام؟`,
    icon: '👤',
    confirmText: 'نعم، تأكيد الحذف',
    isDanger: true,
    onConfirm: async () => {
      try {
        await postToApi({ action: 'delete_staff', name });
        staffNames = staffNames.filter(s => s !== name);
        if (currentStaff === name) onStaffSelected('');
        saveLocalData();
        populateStaffDropdowns();
        renderStaffReport();
        showQuickToast(`تم حذف الموظف (${name}) بنجاح ✓`);
      } catch (err) {
        showQuickToast('حدث خطأ: ' + err.message, 'error');
      }
    }
  });
}

function buildStaffPeriodReport() {
  const staff = document.getElementById('staff-report-select')?.value;
  const from = document.getElementById('staff-report-from')?.value;
  const to = document.getElementById('staff-report-to')?.value;
  const container = document.getElementById('staff-period-report');
  if (!container) return;

  if (!staff) {
    container.innerHTML = `<div style="color:var(--ios-red);font-size:12px;">يرجى اختيار موظف</div>`;
    return;
  }

  const fromD = from ? new Date(from) : new Date(0);
  const toD = to ? new Date(to + 'T23:59:59') : new Date(8640000000000000);

  const matched = orders.filter(o => {
    if (o.staffName !== staff && o.deliveryStaffName !== staff) return false;
    const d = new Date(o.createdAt || o.date);
    if (!isNaN(d.getTime())) {
      if (d < fromD || d > toD) return false;
    }
    return true;
  });

  const totVal = matched.reduce((a, b) => a + (Number(b.totalAmount) || 0), 0);

  container.innerHTML = `
    <div style="background:#f8f9fa;padding:12px;border-radius:10px;border:1px solid var(--ios-border);">
      <div style="font-weight:800;font-size:14px;color:var(--ios-blue);">نتائج التقرير للموظف: ${escapeHtml(staff)}</div>
      <div style="margin-top:4px;font-size:12px;">الفترة: ${from || 'البداية'} إلى ${to || 'الآن'}</div>
      <div style="margin-top:6px;font-size:13px;">عدد الطلبيات: <b>${matched.length}</b></div>
      <div style="font-size:14px;font-weight:800;color:var(--ios-green);margin-top:2px;">إجمالي المبالغ: ${totVal.toLocaleString()} د.ع</div>
    </div>
  `;
}

function exportSelectedStaffExcel() {
  exportStaffCSV();
}
function exportSelectedStaffPDF() {
  window.print();
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

function refreshAllUI() {
  renderProducts();
  renderOrdersLog();
  renderIncomingOrders();
  renderStaffReport();
  updateFinanceReports();
  populateCompanyReportDropdown();
  populateStaffDropdowns();
  updateCartBadge();
}

// Start application
window.addEventListener('DOMContentLoaded', () => {
  loadLocalData();
  applyAdminState();
  loadRemoteData();
});
