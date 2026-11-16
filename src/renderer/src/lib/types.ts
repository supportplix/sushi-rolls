export type Role =
  | 'super_admin'
  | 'owner'
  | 'general_manager'
  | 'branch_manager'
  | 'cashier'
  | 'waiter'
  | 'kitchen'
  | 'inventory_manager'
  | 'accountant'

export interface Profile {
  id: string
  username: string
  full_name: string
  role: Role
  is_active: boolean
  created_at: string
}

export interface Category {
  id: string
  name_ar: string
  name_en: string | null
  sort_order: number
  is_active: boolean
}

export interface Product {
  id: string
  category_id: string | null
  name_ar: string
  name_en: string | null
  description_ar: string | null
  description_en: string | null
  price: number
  cost: number
  sku: string | null
  image_url: string | null
  is_available: boolean
  is_popular: boolean
  is_archived: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export interface ProductVariant {
  id: string
  product_id: string
  name_ar: string
  name_en: string | null
  price_delta: number
  is_default: boolean
  sort_order: number
}

export interface ProductExtra {
  id: string
  name_ar: string
  name_en: string | null
  price: number
  ingredient_id: string | null
  ingredient_qty: number
  is_active: boolean
  sort_order: number
}

export interface Ingredient {
  id: string
  name_ar: string
  name_en: string | null
  sku: string | null
  category: string | null
  unit: string
  quantity: number
  min_stock: number
  purchase_cost: number
  supplier_id: string | null
  expiry_date: string | null
  storage_location: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Supplier {
  id: string
  name: string
  phone: string | null
  address: string | null
  contact_person: string | null
  notes: string | null
  balance: number
  created_at: string
}

export interface RecipeItem {
  id: string
  ingredient_id: string
  quantity: number
  ingredients?: Pick<Ingredient, 'name_ar' | 'unit'>
}

export interface PurchaseOrder {
  id: string
  number: number
  supplier_id: string
  status: 'draft' | 'ordered' | 'received' | 'cancelled'
  total: number
  paid: number
  notes: string | null
  created_by: string | null
  created_at: string
  received_at: string | null
  suppliers?: Pick<Supplier, 'name'>
  purchase_order_items?: PurchaseOrderItem[]
}

export interface PurchaseOrderItem {
  id: string
  purchase_order_id: string
  ingredient_id: string
  quantity: number
  unit_cost: number
  total: number
  ingredients?: Pick<Ingredient, 'name_ar' | 'unit'>
}

export interface Customer {
  id: string
  name: string
  phone: string | null
  address: string | null
  notes: string | null
  total_orders: number
  total_spending: number
  last_order_at: string | null
  created_at: string
}

export interface RTable {
  id: string
  number: string
  capacity: number
  zone: string
  status: 'available' | 'occupied' | 'reserved' | 'cleaning'
  waiter_id: string | null
  pos_x: number
  pos_y: number
  created_at: string
}

export type OrderStatus =
  | 'draft'
  | 'confirmed'
  | 'sent_to_kitchen'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'cancelled'

export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded'
export type OrderType = 'dine_in' | 'takeaway' | 'delivery'

export interface Order {
  id: string
  order_number: number
  status: OrderStatus
  order_type: OrderType
  table_id: string | null
  customer_id: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_address: string | null
  cashier_id: string | null
  waiter_id: string | null
  subtotal: number
  discount_type: 'percent' | 'fixed' | null
  discount_value: number
  discount: number
  tax_rate: number
  tax: number
  total: number
  payment_status: PaymentStatus
  payment_method: string | null
  notes: string | null
  cancel_reason: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  inventory_deducted_at: string | null
  shift_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  order_items?: OrderItem[]
  payments?: Payment[]
  restaurant_tables?: Pick<RTable, 'number' | 'zone'>
  cashier?: Pick<Profile, 'full_name'>
  waiter?: Pick<Profile, 'full_name' | 'id'>
}

export interface OrderItem {
  id: string
  order_id: string
  product_id: string | null
  name_snapshot: string
  variant_name: string | null
  unit_price: number
  cost_snapshot: number
  quantity: number
  notes: string | null
  line_total: number
  order_item_extras?: OrderItemExtra[]
}

export interface OrderItemExtra {
  id: string
  order_item_id: string
  extra_id: string | null
  name_snapshot: string
  price: number
  quantity: number
}

export interface Payment {
  id: string
  order_id: string
  method: string
  amount: number
  reference: string | null
  shift_id: string | null
  created_by: string | null
  created_at: string
}

export interface Refund {
  id: string
  order_id: string
  payment_id: string | null
  amount: number
  reason: string | null
  created_by: string | null
  created_at: string
}

export interface CashShift {
  id: string
  user_id: string
  opened_at: string
  closed_at: string | null
  opening_balance: number
  expected_balance: number | null
  closing_balance: number | null
  difference: number | null
  total_sales: number
  notes: string | null
  status: 'open' | 'closed'
  profiles?: Pick<Profile, 'full_name'>
}

export interface CashTransaction {
  id: number
  shift_id: string
  type: 'opening' | 'sale' | 'refund' | 'withdrawal' | 'addition' | 'closing'
  amount: number
  reference_order: string | null
  note: string | null
  created_by: string | null
  created_at: string
}

export interface Expense {
  id: string
  category_id: string | null
  description: string
  amount: number
  expense_date: string
  payment_method: string | null
  created_by: string | null
  created_at: string
  expense_categories?: Pick<ExpenseCategory, 'name_ar'>
}

export interface ExpenseCategory {
  id: string
  name_ar: string
  name_en: string | null
  is_active: boolean
}

export interface Employee {
  id: string
  profile_id: string | null
  full_name: string
  job_title: string | null
  phone: string | null
  salary: number
  hire_date: string | null
  is_active: boolean
  created_at: string
}

export interface Attendance {
  id: string
  employee_id: string
  check_in: string
  check_out: string | null
  work_date: string
  note: string | null
  employees?: Pick<Employee, 'full_name'>
}

export interface AuditLog {
  id: number
  user_id: string | null
  action: string
  entity: string
  entity_id: string | null
  details: Record<string, unknown> | null
  created_at: string
  profiles?: Pick<Profile, 'full_name' | 'username'>
}

export interface LoginHistory {
  id: number
  user_id: string | null
  username: string | null
  success: boolean
  user_agent: string | null
  created_at: string
}

export interface AppSettings {
  restaurant?: { name?: string; phone?: string; address?: string; logo?: string }
  currency?: { code?: string; symbol?: string }
  tax?: { enabled?: boolean; rate?: number; inclusive?: boolean }
  receipt?: { footer?: string; show_logo?: boolean; show_tax?: boolean; show_cashier?: boolean }
  orders?: { send_to_kitchen?: boolean }
  inventory?: { deduct_on?: string }
  session?: { timeout_minutes?: number }
  language?: { default?: 'ar' | 'en' }
  printing?: { width?: 58 | 80; printer?: string }
}

export interface CartItem {
  key: string
  product: Product
  variant: ProductVariant | null
  extras: { extra: ProductExtra; quantity: number }[]
  quantity: number
  notes: string
  unitPrice: number
  lineTotal: number
}
