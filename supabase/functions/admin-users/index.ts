// SUSHI ROLLS admin user management (runs with the service role).
// Deploy: supabase functions deploy admin-users
//
// Actions: create | update | reset_password | delete
// Only callers with users.manage (owner / super_admin / explicit override) pass.

import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const EMAIL_DOMAIN = 'sushirolls.local'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const authHeader = req.headers.get('Authorization') ?? ''
    const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
    const { data: userData, error: userErr } = await caller.auth.getUser()
    if (userErr || !userData.user) return json({ error: 'UNAUTHORIZED' }, 401)

    const admin = createClient(url, service)
    const { data: profile } = await admin
      .from('profiles')
      .select('role, is_active')
      .eq('id', userData.user.id)
      .maybeSingle()
    if (!profile || !profile.is_active) return json({ error: 'UNAUTHORIZED' }, 401)

    let allowed = profile.role === 'super_admin' || profile.role === 'owner'
    if (!allowed) {
      const { data: override } = await admin
        .from('user_permissions')
        .select('allowed')
        .eq('user_id', userData.user.id)
        .eq('permission', 'users.manage')
        .maybeSingle()
      allowed = override?.allowed === true
    }
    if (!allowed) return json({ error: 'PERMISSION_DENIED' }, 403)

    const body = await req.json()
    const action = String(body.action ?? '')

    if (action === 'create') {
      const username = String(body.username ?? '').trim().toLowerCase()
      const fullName = String(body.full_name ?? '').trim()
      const password = String(body.password ?? '')
      const role = String(body.role ?? 'cashier')
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) return json({ error: 'INVALID_USERNAME' }, 400)
      if (password.length < 6) return json({ error: 'WEAK_PASSWORD' }, 400)

      const { data: created, error } = await admin.auth.admin.createUser({
        email: `${username}@${EMAIL_DOMAIN}`,
        password,
        email_confirm: true,
        user_metadata: { username, full_name: fullName }
      })
      if (error) return json({ error: error.message }, 400)

      const { error: profErr } = await admin.from('profiles').insert({
        id: created.user.id,
        username,
        full_name: fullName || username,
        role
      })
      if (profErr) {
        await admin.auth.admin.deleteUser(created.user.id)
        return json({ error: profErr.message }, 400)
      }
      return json({ ok: true, id: created.user.id })
    }

    const targetId = String(body.id ?? '')
    if (!targetId) return json({ error: 'MISSING_ID' }, 400)

    if (action === 'update') {
      const patch: Record<string, unknown> = {}
      if (body.full_name !== undefined) patch.full_name = String(body.full_name)
      if (body.role !== undefined) patch.role = String(body.role)
      if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active)
      if (Object.keys(patch).length > 0) {
        const { error } = await admin.from('profiles').update(patch).eq('id', targetId)
        if (error) return json({ error: error.message }, 400)
      }
      if (body.password) {
        const { error } = await admin.auth.admin.updateUserById(targetId, {
          password: String(body.password)
        })
        if (error) return json({ error: error.message }, 400)
      }
      if (body.is_active !== undefined) {
        await admin.auth.admin.updateUserById(targetId, {
          ban_duration: body.is_active ? 'none' : '876000h'
        })
        if (body.is_active === false) {
          await admin.from('user_permissions').delete().eq('user_id', targetId)
        }
      }
      return json({ ok: true })
    }

    if (action === 'reset_password') {
      const password = String(body.password ?? '')
      if (password.length < 6) return json({ error: 'WEAK_PASSWORD' }, 400)
      const { error } = await admin.auth.admin.updateUserById(targetId, { password })
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    if (action === 'delete') {
      if (profile.role !== 'super_admin' && profile.role !== 'owner') {
        return json({ error: 'PERMISSION_DENIED' }, 403)
      }
      if (targetId === userData.user.id) return json({ error: 'CANNOT_DELETE_SELF' }, 400)
      const { error } = await admin.auth.admin.deleteUser(targetId)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    return json({ error: 'UNKNOWN_ACTION' }, 400)
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
})
