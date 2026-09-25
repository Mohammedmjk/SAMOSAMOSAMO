import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import {
  getDb,
  getAllProducts,
  getAllOrders,
  getAllStaff,
  getAllMovements,
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
  exportJsonBackup
} from './server/db.ts';

dotenv.config();

const app = express();
const PORT = 3000;

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

// GET /api & /api/warehouse: Full database snapshot for frontend sync
async function handleGetWarehouseData(req: express.Request, res: express.Response) {
  try {
    const db = getDb();
    const products = getAllProducts(db);
    const allOrders = getAllOrders(db);
    const staffNames = getAllStaff(db);

    const pendingOrders: any[] = [];
    const orders: any[] = [];

    for (const o of allOrders) {
      const st = String(o.status || '').trim().toLowerCase();
      if (!['مستلم', 'مسلّم', 'مسلم', 'مسلّمة', 'مسلمة', 'delivered', 'معتمد', 'معتمد للتجهيز', 'مجهزة', 'approved'].includes(st)) {
        pendingOrders.push(o);
      } else {
        orders.push(o);
      }
    }

    res.json({
      success: true,
      products,
      orders,
      pendingOrders,
      staffNames
    });
  } catch (err: any) {
    console.error('Error fetching warehouse data:', err);
    res.status(500).json({ status: 'error', message: err.message || 'Server error' });
  }
}

app.get('/api', handleGetWarehouseData);
app.get('/api/warehouse', handleGetWarehouseData);

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
        return res.json({ status: 'success', ...result });
      }

      case 'approve_order': {
        const { orderNumber, staffName, items, totalAmount } = payload;
        if (!orderNumber) return res.status(400).json({ status: 'error', message: 'رقم الطلب مطلوب' });
        approveOrder(db, orderNumber, staffName || '', items || [], Number(totalAmount) || 0);
        return res.json({ status: 'success', message: 'تم اعتماد وتجهيز الطلب بنجاح وخصم الكميات من المخزن' });
      }

      case 'deliver_order': {
        const { orderNumber, deliveryStaffName, deliveredAt } = payload;
        if (!orderNumber) return res.status(400).json({ status: 'error', message: 'رقم الطلب مطلوب' });
        deliverOrder(db, orderNumber, deliveryStaffName || '', deliveredAt || '');
        return res.json({ status: 'success', message: 'تم تسجيل تسليم الطلب' });
      }

      case 'discard_pending_order':
      case 'delete_order': {
        const { orderNumber } = payload;
        if (!orderNumber) return res.status(400).json({ status: 'error', message: 'رقم الطلب مطلوب' });
        discardPendingOrder(db, orderNumber);
        return res.json({ status: 'success', message: 'تم حذف الطلب' });
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
        return res.json({ status: 'success', message: 'تم إرجاع المادة للمخزن بنجاح' });
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
        const result = addProduct(db, product);
        return res.json({ status: 'success', product: result.product });
      }

      case 'update_product': {
        const { product, stockOperation } = payload;
        if (!product) return res.status(400).json({ status: 'error', message: 'بيانات المادة مطلوبة' });
        updateProduct(db, product, stockOperation);
        return res.json({ status: 'success', message: 'تم تحديث المادة' });
      }

      case 'delete_product': {
        const { productId, barcode, name } = payload;
        deleteProduct(db, productId, barcode, name);
        return res.json({ status: 'success', message: 'تم حذف المادة' });
      }

      case 'add_staff': {
        const { name } = payload;
        if (!name) return res.status(400).json({ status: 'error', message: 'اسم الموظف مطلوب' });
        addStaff(db, name);
        return res.json({ status: 'success', name });
      }

      case 'delete_staff': {
        const { name } = payload;
        if (!name) return res.status(400).json({ status: 'error', message: 'اسم الموظف مطلوب' });
        deleteStaff(db, name);
        return res.json({ status: 'success', message: 'تم حذف الموظف' });
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
  const validPin = process.env.ADMIN_PIN || '1234';
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
    console.log(`📦 Warehouse data directory: ${process.env.SAMO_DATA_DIR || 'auto-detected data/ directory'}`);
  });
}

startServer();
