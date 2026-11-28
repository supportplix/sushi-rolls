import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/lib/auth'
import { ToastProvider } from '@/components/ui/toast'
import { AppShell, Guard } from '@/components/layout/AppShell'
import { BootSplash, Connect, Login, SchemaGuide, Setup } from '@/pages/AuthScreens'
import Dashboard from '@/pages/Dashboard'
import LivePage from '@/pages/LivePage'
import PosPage from '@/pages/PosPage'
import OrdersPage from '@/pages/OrdersPage'
import TablesPage from '@/pages/TablesPage'
import KdsPage from '@/pages/KdsPage'
import MenuPage from '@/pages/MenuPage'
import InventoryPage from '@/pages/InventoryPage'
import PurchasesPage from '@/pages/PurchasesPage'
import SuppliersPage from '@/pages/SuppliersPage'
import CustomersPage from '@/pages/CustomersPage'
import ExpensesPage from '@/pages/ExpensesPage'
import CashPage from '@/pages/CashPage'
import EmployeesPage from '@/pages/EmployeesPage'
import ReportsPage from '@/pages/ReportsPage'
import UsersPage from '@/pages/UsersPage'
import SettingsPage from '@/pages/SettingsPage'

function Root(): JSX.Element {
  const { phase } = useAuth()

  if (phase === 'booting') return <BootSplash />
  if (phase === 'connect') return <Connect />
  if (phase === 'schema') return <SchemaGuide />
  if (phase === 'setup') return <Setup />
  if (phase === 'login') return <Login />

  return (
    <HashRouter>
      <Routes>
        <Route
          path="/kds"
          element={
            <Guard perm="kds.use">
              <KdsPage />
            </Guard>
          }
        />
        <Route element={<AppShell />}>
          <Route
            index
            element={
              <Guard perm="dashboard.view">
                <Dashboard />
              </Guard>
            }
          />
          <Route path="/live" element={<Guard perm="dashboard.view"><LivePage /></Guard>} />
          <Route path="/pos" element={<Guard perm="pos.use"><PosPage /></Guard>} />
          <Route path="/orders" element={<Guard perm="orders.view"><OrdersPage /></Guard>} />
          <Route path="/tables" element={<Guard perm="tables.manage"><TablesPage /></Guard>} />
          <Route path="/menu" element={<Guard perm="menu.view"><MenuPage /></Guard>} />
          <Route path="/inventory" element={<Guard perm="inventory.view"><InventoryPage /></Guard>} />
          <Route path="/purchases" element={<Guard perm="purchases.view"><PurchasesPage /></Guard>} />
          <Route path="/suppliers" element={<Guard perm="suppliers.view"><SuppliersPage /></Guard>} />
          <Route path="/customers" element={<Guard perm="customers.view"><CustomersPage /></Guard>} />
          <Route path="/expenses" element={<Guard perm="expenses.view"><ExpensesPage /></Guard>} />
          <Route path="/cash" element={<Guard perm={['cash.manage', 'cash.review']}><CashPage /></Guard>} />
          <Route path="/employees" element={<Guard perm="employees.view"><EmployeesPage /></Guard>} />
          <Route path="/reports" element={<Guard perm="reports.view"><ReportsPage /></Guard>} />
          <Route path="/users" element={<Guard perm="users.manage"><UsersPage /></Guard>} />
          <Route path="/settings" element={<Guard perm={['settings.manage', 'backup.manage']}><SettingsPage /></Guard>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}

export default function App(): JSX.Element {
  return (
    <ToastProvider>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </ToastProvider>
  )
}
