import type { SupabaseClient } from '@supabase/supabase-js'
import type { Order, OrderItem, Payment } from './types'

export interface OrderFull {
  order: Order
  items: OrderItem[]
  payments: Payment[]
}

export async function fetchOrderFull(db: SupabaseClient, orderId: string): Promise<OrderFull | null> {
  const { data, error } = await db
    .from('orders')
    .select(
      '*, order_items(*, order_item_extras(*)), payments(*), cashier:profiles!orders_cashier_id_fkey(full_name), restaurant_tables(number, zone)'
    )
    .eq('id', orderId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as unknown as Order & { order_items: OrderItem[]; payments: Payment[] }
  return {
    order: row,
    items: row.order_items ?? [],
    payments: row.payments ?? []
  }
}

export const ORDER_LIST_SELECT =
  '*, cashier:profiles!orders_cashier_id_fkey(full_name), restaurant_tables(number, zone), order_items(count)'
