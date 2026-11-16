import type { Role } from './types'

export interface Option {
  value: string
  ar: string
  en: string
  color?: string
}

export const ROLES: (Option & { value: Role })[] = [
  { value: 'super_admin', ar: 'سوبر أدمن', en: 'Super Admin', color: '#E50E05' },
  { value: 'owner', ar: 'صاحب المطعم', en: 'Restaurant Owner', color: '#E4BE54' },
  { value: 'general_manager', ar: 'مدير عام', en: 'General Manager', color: '#E4BE54' },
  { value: 'branch_manager', ar: 'مدير فرع', en: 'Branch Manager', color: '#9BA1A6' },
  { value: 'cashier', ar: 'كاشير', en: 'Cashier', color: '#9BA1A6' },
  { value: 'waiter', ar: 'ويتر', en: 'Waiter', color: '#9BA1A6' },
  { value: 'kitchen', ar: 'موظف مطبخ', en: 'Kitchen Staff', color: '#9BA1A6' },
  { value: 'inventory_manager', ar: 'مسؤول مخزن', en: 'Inventory Manager', color: '#9BA1A6' },
  { value: 'accountant', ar: 'محاسب', en: 'Accountant', color: '#9BA1A6' }
]

export const ORDER_STATUS: (Option & { value: string })[] = [
  { value: 'draft', ar: 'مسودة', en: 'Draft', color: '#6B7176' },
  { value: 'confirmed', ar: 'مؤكد', en: 'Confirmed', color: '#E4BE54' },
  { value: 'sent_to_kitchen', ar: 'في المطبخ', en: 'Sent to Kitchen', color: '#E4BE54' },
  { value: 'preparing', ar: 'قيد التحضير', en: 'Preparing', color: '#FF8A3D' },
  { value: 'ready', ar: 'جاهز', en: 'Ready', color: '#3DBE7A' },
  { value: 'completed', ar: 'مكتمل', en: 'Completed', color: '#3DBE7A' },
  { value: 'cancelled', ar: 'ملغي', en: 'Cancelled', color: '#E50E05' }
]

export const PAYMENT_STATUS: Option[] = [
  { value: 'unpaid', ar: 'غير مدفوع', en: 'Unpaid', color: '#E50E05' },
  { value: 'partial', ar: 'مدفوع جزئياً', en: 'Partial', color: '#E4BE54' },
  { value: 'paid', ar: 'مدفوع', en: 'Paid', color: '#3DBE7A' },
  { value: 'refunded', ar: 'مسترد', en: 'Refunded', color: '#FF8A3D' }
]

export const ORDER_TYPES: Option[] = [
  { value: 'dine_in', ar: 'صالة', en: 'Dine In' },
  { value: 'takeaway', ar: 'تيك أواي', en: 'Takeaway' },
  { value: 'delivery', ar: 'دليفري', en: 'Delivery' }
]

export const PAYMENT_METHODS: Option[] = [
  { value: 'cash', ar: 'نقدي', en: 'Cash' },
  { value: 'card', ar: 'بطاقة بنكية', en: 'Bank Card' },
  { value: 'instapay', ar: 'إنستاباي', en: 'InstaPay' },
  { value: 'wallet', ar: 'محفظة إلكترونية', en: 'Wallet' },
  { value: 'other', ar: 'أخرى', en: 'Other' }
]

export const TABLE_STATUS: Option[] = [
  { value: 'available', ar: 'متاحة', en: 'Available', color: '#3DBE7A' },
  { value: 'occupied', ar: 'مشغولة', en: 'Occupied', color: '#E50E05' },
  { value: 'reserved', ar: 'محجوزة', en: 'Reserved', color: '#E4BE54' },
  { value: 'cleaning', ar: 'تنظيف', en: 'Cleaning', color: '#6B7176' }
]

export const STOCK_TYPES: Option[] = [
  { value: 'in', ar: 'إدخال مخزون', en: 'Stock In', color: '#3DBE7A' },
  { value: 'out', ar: 'صرف', en: 'Stock Out', color: '#E4BE54' },
  { value: 'adjustment', ar: 'تسوية جرد', en: 'Adjustment', color: '#9BA1A6' },
  { value: 'waste', ar: 'هالك', en: 'Waste', color: '#E50E05' },
  { value: 'damage', ar: 'تالف', en: 'Damaged', color: '#E50E05' },
  { value: 'expired', ar: 'منتهي الصلاحية', en: 'Expired', color: '#E50E05' },
  { value: 'transfer', ar: 'تحويل', en: 'Transfer', color: '#9BA1A6' },
  { value: 'purchase', ar: 'شراء', en: 'Purchase', color: '#3DBE7A' },
  { value: 'sale', ar: 'بيع', en: 'Sale', color: '#E4BE54' },
  { value: 'reversal', ar: 'إرجاع', en: 'Reversal', color: '#9BA1A6' }
]

export const CASH_TX_TYPES: Option[] = [
  { value: 'opening', ar: 'رصيد افتتاحي', en: 'Opening' },
  { value: 'sale', ar: 'مبيعات نقدية', en: 'Cash Sale' },
  { value: 'refund', ar: 'استرداد', en: 'Refund' },
  { value: 'withdrawal', ar: 'سحب نقدي', en: 'Withdrawal' },
  { value: 'addition', ar: 'إضافة نقدية', en: 'Addition' },
  { value: 'closing', ar: 'إغلاق', en: 'Closing' }
]

export const PURCHASE_STATUS: Option[] = [
  { value: 'draft', ar: 'مسودة', en: 'Draft', color: '#6B7176' },
  { value: 'ordered', ar: 'تم الطلب', en: 'Ordered', color: '#E4BE54' },
  { value: 'received', ar: 'تم الاستلام', en: 'Received', color: '#3DBE7A' },
  { value: 'cancelled', ar: 'ملغي', en: 'Cancelled', color: '#E50E05' }
]

export const PERMISSIONS: { key: string; ar: string; en: string; group: string }[] = [
  { key: 'dashboard.view', ar: 'عرض الداشبورد', en: 'View dashboard', group: 'general' },
  { key: 'pos.use', ar: 'استخدام نقطة البيع', en: 'Use POS', group: 'pos' },
  { key: 'orders.view', ar: 'عرض الأوردرات', en: 'View orders', group: 'pos' },
  { key: 'orders.cancel', ar: 'إلغاء أوردر', en: 'Cancel orders', group: 'pos' },
  { key: 'orders.refund', ar: 'استرداد مبالغ', en: 'Refund orders', group: 'pos' },
  { key: 'tables.manage', ar: 'إدارة الترابيزات', en: 'Manage tables', group: 'pos' },
  { key: 'kds.use', ar: 'شاشة المطبخ', en: 'Kitchen display', group: 'pos' },
  { key: 'menu.view', ar: 'عرض القائمة', en: 'View menu', group: 'menu' },
  { key: 'menu.manage', ar: 'إدارة القائمة', en: 'Manage menu', group: 'menu' },
  { key: 'inventory.view', ar: 'عرض المخزون', en: 'View inventory', group: 'inventory' },
  { key: 'inventory.manage', ar: 'إدارة المخزون', en: 'Manage inventory', group: 'inventory' },
  { key: 'purchases.view', ar: 'عرض المشتريات', en: 'View purchases', group: 'inventory' },
  { key: 'purchases.manage', ar: 'إدارة المشتريات', en: 'Manage purchases', group: 'inventory' },
  { key: 'suppliers.view', ar: 'عرض الموردين', en: 'View suppliers', group: 'inventory' },
  { key: 'suppliers.manage', ar: 'إدارة الموردين', en: 'Manage suppliers', group: 'inventory' },
  { key: 'customers.view', ar: 'عرض العملاء', en: 'View customers', group: 'customers' },
  { key: 'customers.manage', ar: 'إدارة العملاء', en: 'Manage customers', group: 'customers' },
  { key: 'expenses.view', ar: 'عرض المصاريف', en: 'View expenses', group: 'finance' },
  { key: 'expenses.manage', ar: 'إدارة المصاريف', en: 'Manage expenses', group: 'finance' },
  { key: 'cash.manage', ar: 'تشغيل الوردية والكاش', en: 'Manage cash shift', group: 'finance' },
  { key: 'cash.review', ar: 'مراجعة الورديات', en: 'Review shifts', group: 'finance' },
  { key: 'employees.view', ar: 'عرض الموظفين', en: 'View employees', group: 'staff' },
  { key: 'employees.manage', ar: 'إدارة الموظفين', en: 'Manage employees', group: 'staff' },
  { key: 'reports.view', ar: 'عرض التقارير', en: 'View reports', group: 'reports' },
  { key: 'users.manage', ar: 'إدارة المستخدمين', en: 'Manage users', group: 'admin' },
  { key: 'settings.manage', ar: 'إدارة الإعدادات', en: 'Manage settings', group: 'admin' },
  { key: 'backup.manage', ar: 'النسخ الاحتياطي', en: 'Backups', group: 'admin' },
  { key: 'audit.view', ar: 'عرض سجل النشاط', en: 'View audit log', group: 'admin' }
]

const ALL = PERMISSIONS.map((p) => p.key)

export const ROLE_DEFAULTS: Record<Role, string[]> = {
  super_admin: ALL,
  owner: ALL,
  general_manager: ALL.filter((p) => !['users.manage', 'settings.manage', 'backup.manage'].includes(p)),
  branch_manager: [
    'dashboard.view', 'pos.use', 'orders.view', 'orders.cancel', 'tables.manage', 'kds.use',
    'menu.view', 'menu.manage', 'inventory.view', 'inventory.manage', 'purchases.view',
    'purchases.manage', 'suppliers.view', 'suppliers.manage', 'customers.view',
    'customers.manage', 'cash.manage', 'cash.review', 'employees.view', 'reports.view'
  ],
  cashier: ['pos.use', 'orders.view', 'tables.manage', 'menu.view', 'customers.view', 'customers.manage', 'cash.manage'],
  waiter: ['pos.use', 'orders.view', 'tables.manage', 'menu.view'],
  kitchen: ['kds.use', 'menu.view', 'inventory.view'],
  inventory_manager: [
    'orders.view', 'menu.view', 'inventory.view', 'inventory.manage', 'purchases.view',
    'purchases.manage', 'suppliers.view', 'suppliers.manage', 'reports.view'
  ],
  accountant: [
    'dashboard.view', 'orders.view', 'menu.view', 'customers.view', 'expenses.view',
    'expenses.manage', 'cash.review', 'reports.view', 'audit.view', 'inventory.view',
    'suppliers.view', 'purchases.view'
  ]
}

export function labelOf(list: Option[], value: string | null | undefined, lang: 'ar' | 'en'): string {
  const found = list.find((o) => o.value === value)
  if (!found) return value ?? '—'
  return lang === 'ar' ? found.ar : found.en
}

export function colorOf(list: Option[], value: string | null | undefined): string | undefined {
  return list.find((o) => o.value === value)?.color
}
