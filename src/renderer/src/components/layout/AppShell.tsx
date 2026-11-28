import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Banknote,
  BookOpen,
  Boxes,
  ChefHat,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Coffee,
  LayoutDashboard,
  LogOut,
  MonitorPlay,
  PackageSearch,
  ReceiptText,
  Settings,
  ShoppingCart,
  Store,
  Users,
  UsersRound,
  Wallet,
  Wifi,
  WifiOff
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuth, useDb } from '@/lib/auth'
import { api } from '@/lib/ipc'
import { t } from '@/i18n'
import { labelOf, ROLES } from '@/lib/constants'
import { initials } from '@/lib/format'
import { logoDataUrl } from '@/lib/logo'
import { SHIFT_EVENT } from '@/lib/shift'
import { AuroraField } from './AuroraField'
import { UpdateBanner } from './UpdateBanner'

interface NavItem {
  to: string
  label: string
  icon: JSX.Element
  perms: string[]
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const GROUPS: NavGroup[] = [
  {
    label: 'الرئيسية',
    items: [
      { to: '/', label: t('nav.dashboard'), icon: <LayoutDashboard className="h-[18px] w-[18px]" />, perms: ['dashboard.view'] },
      { to: '/live', label: t('nav.live'), icon: <Activity className="h-[18px] w-[18px]" />, perms: ['dashboard.view'] },
      { to: '/pos', label: t('nav.pos'), icon: <ShoppingCart className="h-[18px] w-[18px]" />, perms: ['pos.use'] }
    ]
  },
  {
    label: 'التشغيل',
    items: [
      { to: '/orders', label: t('nav.orders'), icon: <ReceiptText className="h-[18px] w-[18px]" />, perms: ['orders.view', 'pos.use'] },
      { to: '/tables', label: t('nav.tables'), icon: <Coffee className="h-[18px] w-[18px]" />, perms: ['tables.manage'] },
      { to: '/kds', label: t('nav.kds'), icon: <ChefHat className="h-[18px] w-[18px]" />, perms: ['kds.use'] }
    ]
  },
  {
    label: 'الكتالوج',
    items: [
      { to: '/menu', label: t('nav.menu'), icon: <BookOpen className="h-[18px] w-[18px]" />, perms: ['menu.view', 'menu.manage'] },
      { to: '/inventory', label: t('nav.inventory'), icon: <Boxes className="h-[18px] w-[18px]" />, perms: ['inventory.view', 'inventory.manage'] },
      { to: '/purchases', label: t('nav.purchases'), icon: <ClipboardList className="h-[18px] w-[18px]" />, perms: ['purchases.view', 'purchases.manage'] },
      { to: '/suppliers', label: t('nav.suppliers'), icon: <PackageSearch className="h-[18px] w-[18px]" />, perms: ['suppliers.view', 'suppliers.manage'] }
    ]
  },
  {
    label: 'العملاء',
    items: [
      { to: '/customers', label: t('nav.customers'), icon: <UsersRound className="h-[18px] w-[18px]" />, perms: ['customers.view'] }
    ]
  },
  {
    label: 'المالية',
    items: [
      { to: '/expenses', label: t('nav.expenses'), icon: <Wallet className="h-[18px] w-[18px]" />, perms: ['expenses.view', 'expenses.manage'] },
      { to: '/cash', label: t('nav.cash'), icon: <Banknote className="h-[18px] w-[18px]" />, perms: ['cash.manage', 'cash.review'] }
    ]
  },
  {
    label: 'الفريق',
    items: [
      { to: '/employees', label: t('nav.employees'), icon: <Users className="h-[18px] w-[18px]" />, perms: ['employees.view', 'employees.manage'] },
      { to: '/reports', label: t('nav.reports'), icon: <BarChart3 className="h-[18px] w-[18px]" />, perms: ['reports.view'] }
    ]
  },
  {
    label: 'الإدارة',
    items: [
      { to: '/users', label: t('nav.users'), icon: <UsersRound className="h-[18px] w-[18px]" />, perms: ['users.manage'] },
      { to: '/settings', label: t('nav.settings'), icon: <Settings className="h-[18px] w-[18px]" />, perms: ['settings.manage', 'backup.manage'] },
    ]
  }
]

function useShiftState(): { open: boolean; since: string | null; loading: boolean } {
  const db = useDb()
  const { profile } = useAuth()
  const [state, setState] = useState<{ open: boolean; since: string | null; loading: boolean }>({
    open: false,
    since: null,
    loading: true
  })

  useEffect(() => {
    if (!profile) return
    let alive = true
    const load = async (): Promise<void> => {
      const { data } = await db
        .from('cash_shifts')
        .select('opened_at')
        .eq('user_id', profile.id)
        .eq('status', 'open')
        .maybeSingle()
      if (alive) setState({ open: !!data, since: data?.opened_at ?? null, loading: false })
    }
    void load()
    window.addEventListener(SHIFT_EVENT, load)
    const timer = setInterval(load, 60_000)
    return () => {
      alive = false
      window.removeEventListener(SHIFT_EVENT, load)
      clearInterval(timer)
    }
  }, [db, profile])

  return state
}

export function AppShell(): JSX.Element {
  const { profile, can, signOut } = useAuth()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sushi.sidebar') === '1')
  const [logo, setLogo] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const shift = useShiftState()
  const location = useLocation()

  useEffect(() => {
    void logoDataUrl().then(setLogo)
    const on = (): void => setOnline(true)
    const off = (): void => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('sushi.sidebar', collapsed ? '1' : '0')
  }, [collapsed])

  const visibleGroups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) => item.perms.some((p) => can(p)))
  })).filter((g) => g.items.length > 0)

  return (
    <div className="relative flex h-screen overflow-hidden bg-ink">
      <AuroraField />
      <div className="app-drag fixed inset-x-0 top-0 z-[60] h-[38px]" />

      <aside
        className={cn(
          'relative z-40 mb-3 me-0 ms-3 mt-[46px] flex h-[calc(100vh-58px)] shrink-0 flex-col overflow-hidden',
          'rounded-[26px] border border-white/[0.065] bg-[#0A0B0D]/[0.72] shadow-card backdrop-blur-2xl transition-[width] duration-300',
          collapsed ? 'w-[78px]' : 'w-[250px]'
        )}
      >
        <div className={cn('flex items-center gap-3 px-4 pb-5 pt-5', collapsed && 'justify-center px-2')}>
          {logo ? (
            <img
              src={logo}
              alt="SUSHI ROLLS"
              className="h-11 w-11 shrink-0 object-contain drop-shadow-[0_14px_28px_rgba(229,14,5,0.28)]"
            />
          ) : (
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
              <Store className="h-5 w-5 text-brand-gold" />
            </div>
          )}
          {!collapsed && (
            <div className="min-w-0">
              <div className="truncate text-[15px] font-black tracking-wide">SUSHI ROLLS</div>
              <div className="text-[10px] font-semibold tracking-wide text-txt-faint">{t('app.tagline')}</div>
            </div>
          )}
        </div>

        <nav className="scroll-area min-h-0 flex-1 px-2.5 pb-3">
          {visibleGroups.map((group) => (
            <div key={group.label} className="mb-4">
              {!collapsed && (
                <div className="px-3 pb-2 pt-1 text-[9px] font-bold uppercase tracking-[0.2em] text-white/25">
                  {group.label}
                </div>
              )}
              <div className="space-y-1">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      cn(
                        'relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[12.5px] font-semibold transition-all duration-200',
                        collapsed && 'justify-center px-0',
                        isActive
                          ? 'bg-gradient-to-l from-brand-red/[0.22] via-brand-red/[0.07] to-transparent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
                          : 'text-txt-dim hover:bg-white/[0.05] hover:text-txt'
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className={cn('shrink-0 transition-colors', isActive ? 'text-brand-gold' : 'text-txt-faint')}>
                          {item.icon}
                        </span>
                        {!collapsed && <span className="truncate">{item.label}</span>}
                        {isActive && (
                          <span className="absolute end-1 top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-full bg-gradient-to-b from-brand-gold to-brand-red" />
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-white/[0.06] p-3">
          <div className={cn('flex items-center gap-2.5 rounded-2xl bg-white/[0.035] p-2', collapsed && 'justify-center bg-transparent p-1')}>
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-brand-gold/25 bg-brand-gold/10 text-[11px] font-black text-brand-gold">
              {initials(profile?.full_name ?? '؟')}
            </div>
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-bold">{profile?.full_name}</div>
                <div className="truncate text-[10px] text-txt-faint">{labelOf(ROLES, profile?.role, 'ar')}</div>
              </div>
            )}
            {!collapsed && (
              <button
                type="button"
                onClick={() => void signOut()}
                aria-label={t('common.logout')}
                className="grid h-8 w-8 place-items-center rounded-lg text-txt-faint transition hover:bg-brand-red/10 hover:text-brand-redSoft"
              >
                <LogOut className="h-4 w-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] font-semibold text-txt-faint transition hover:bg-white/[0.04] hover:text-txt-dim"
          >
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : (<><ChevronLeft className="h-3.5 w-3.5" /> تصغير القائمة</>)}
          </button>
        </div>
      </aside>

      <div className="relative z-10 flex min-w-0 flex-1 flex-col pt-[46px]">
        <header className="mx-3 flex h-[52px] shrink-0 items-center justify-between gap-3 rounded-2xl border border-white/[0.065] bg-[#0A0B0D]/60 px-4 backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  !online ? 'bg-brand-red' : shift.open ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]' : 'bg-brand-gold'
                )}
              />
              <span className="text-txt-dim">
                {!online ? t('common.offline') : shift.open ? t('shift.open') : t('shift.none')}
              </span>
            </div>
            <div className="hidden items-center gap-1.5 text-[11px] text-txt-faint md:flex">
              {online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
                weekday: 'long',
                day: '2-digit',
                month: 'long'
              }).format(new Date())}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void api.app.openKds()}
              className="btn btn-sm border border-brand-gold/25 bg-brand-gold/[0.07] text-brand-gold hover:bg-brand-gold/[0.12]"
            >
              <MonitorPlay className="h-3.5 w-3.5" />
              {t('kds.openWindow')}
            </button>
            {profile?.role && (
              <span className="rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-[10px] font-bold text-txt-faint">
                {labelOf(ROLES, profile.role, 'ar')}
              </span>
            )}
          </div>
        </header>

        <UpdateBanner />

        <main className="scroll-area relative flex-1 px-3 pb-6 pt-3 lg:px-5">
          <div key={location.pathname} className="relative animate-fadeUp">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

export function Guard({ perm, children }: { perm: string | string[]; children: JSX.Element }): JSX.Element {
  const { can } = useAuth()
  const allowed = Array.isArray(perm) ? perm.some((p) => can(p)) : can(perm)
  if (!allowed) {
    return (
      <div className="grid h-64 place-items-center">
        <div className="card flex max-w-sm flex-col items-center gap-2 px-8 py-10 text-center">
          <ArrowLeftRight className="h-6 w-6 text-brand-redSoft" />
          <div className="text-sm font-bold">{t('common.noPermission')}</div>
        </div>
      </div>
    )
  }
  return children
}
