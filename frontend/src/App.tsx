import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type User = { id: number; email: string; name: string; role: 'ADMIN' | 'AGENT' }
type Ticket = { id: number; customerName: string; title: string; description: string; priority: string; status: string; assigneeId: number | null; assigneeName: string | null; promisedResponseAt: string; overdue: boolean }
type Dashboard = { total: number; open: number; overdue: number; assigned: number; recentlyEscalated: Array<{ action: string; ticket: { id: number; title: string }; occurredAt: string; previousValue: string | null; newValue: string | null }> }

const api = async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('content-type', 'application/json')
  const csrf = document.cookie.split('; ').find((item) => item.startsWith('csrf='))?.split('=')[1]
  if (csrf && options.method && options.method !== 'GET') headers.set('x-csrf-token', csrf)
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'include' })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? 'Request failed')
  return response.json() as Promise<T>
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    try { onLogin(await api<User>(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body: JSON.stringify(form) })) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Unable to sign in') }
  }
  return <main className="auth-shell"><section className="auth-panel"><p className="eyebrow">AURIGA / OPERATIONS</p><h1>Keep the queue moving.</h1><p className="muted">A focused workspace for response commitments, ownership, and escalation.</p><form onSubmit={submit}>
    {mode === 'register' && <label>Full name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>}
    <label>Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
    <label>Password<input required minLength={12} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
    {error && <p className="error">{error}</p>}<button className="primary" type="submit">{mode === 'login' ? 'Enter workspace' : 'Create administrator'}</button>
  </form><button className="text-button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'First-time setup' : 'Back to sign in'}</button></section></main>
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [filters, setFilters] = useState({ search: '', priority: '', status: '', overdue: '' })
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [newTicket, setNewTicket] = useState({ customerName: '', title: '', description: '', promisedResponseAt: '' })

  const load = async () => {
    const query = new URLSearchParams({ page: String(page), pageSize: '12' })
    Object.entries(filters).forEach(([key, value]) => { if (value) query.set(key, value) })
    try { const [queue, stats] = await Promise.all([api<{ data: Ticket[]; total: number }>(`/tickets?${query}`), api<Dashboard>('/dashboard')]); setTickets(queue.data); setTotal(queue.total); setDashboard(stats); setError('') }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Unable to load queue') }
  }
  useEffect(() => { api<User>('/auth/me').then(setUser).catch(() => undefined).finally(() => setReady(true)) }, [])
  useEffect(() => { if (user?.role === 'ADMIN') void api<User[]>('/users').then(setUsers).catch(() => setError('Unable to load assignees')) }, [user])
  // Queue refresh is an async synchronization with the API, not a render-derived state transition.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { if (user) void load() }, [user, page, filters])

  if (!ready) return <div className="loading">Loading workspace...</div>
  if (!user) return <Login onLogin={setUser} />

  const updateTicket = async (id: number, field: 'status' | 'priority', value: string) => { await api(`/tickets/${id}`, { method: 'PATCH', body: JSON.stringify({ [field]: value }) }); await load() }
  const assignTicket = async (id: number, assigneeId: string) => { try { await api(`/tickets/${id}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: assigneeId ? Number(assigneeId) : null }) }); await load() } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Unable to assign ticket') } }
  const createTicket = async (event: FormEvent) => { event.preventDefault(); await api('/tickets', { method: 'POST', body: JSON.stringify({ ...newTicket, promisedResponseAt: new Date(newTicket.promisedResponseAt).toISOString() }) }); setShowCreate(false); setNewTicket({ customerName: '', title: '', description: '', promisedResponseAt: '' }); await load() }
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setUser(null) }

  return <div className="app-shell"><header className="topbar"><div><p className="eyebrow">AURIGA / HELP DESK</p><h1>Response control room</h1></div><div className="user-menu"><span>{user.name}<small>{user.role}</small></span><button className="quiet-button" onClick={logout}>Sign out</button></div></header>
    <main className="content"><section className="metrics">{[['TOTAL', dashboard?.total ?? 0], ['OPEN', dashboard?.open ?? 0], ['OVERDUE', dashboard?.overdue ?? 0], ['MY QUEUE', dashboard?.assigned ?? 0]].map(([label, value]) => <div className="metric" key={label as string}><span>{label}</span><strong>{value}</strong></div>)}</section>
      <section className="queue-heading"><div><p className="eyebrow">LIVE PRIORITIZATION</p><h2>Active queue</h2><p className="muted">Overdue first, then priority, response deadline, age, and ticket ID.</p></div><button className="primary" onClick={() => setShowCreate(true)}>New ticket</button></section>
      <section className="filters"><input aria-label="Search customers" placeholder="Search customer name" value={filters.search} onChange={(e) => { setPage(1); setFilters({ ...filters, search: e.target.value }) }} /><select value={filters.priority} onChange={(e) => { setPage(1); setFilters({ ...filters, priority: e.target.value }) }}><option value="">All priorities</option><option>URGENT</option><option>HIGH</option><option>NORMAL</option><option>LOW</option></select><select value={filters.status} onChange={(e) => { setPage(1); setFilters({ ...filters, status: e.target.value }) }}><option value="">All statuses</option><option>OPEN</option><option>PENDING</option><option>IN_PROGRESS</option></select><select value={filters.overdue} onChange={(e) => { setPage(1); setFilters({ ...filters, overdue: e.target.value }) }}><option value="">All deadlines</option><option value="true">Overdue only</option><option value="false">On time only</option></select></section>
      {error && <div className="error banner">{error}</div>}<section className="queue-list">{tickets.length === 0 ? <div className="empty"><strong>No active tickets match these filters.</strong><span>The queue is clear for this view.</span></div> : tickets.map((ticket, index) => <article className={`ticket-row ${ticket.overdue ? 'is-overdue' : ''}`} key={ticket.id}><div className="position">{String((page - 1) * 12 + index + 1).padStart(2, '0')}</div><div className="ticket-main"><div className="ticket-title"><span className={`priority ${ticket.priority.toLowerCase()}`}>{ticket.priority}</span><h3>{ticket.title}</h3>{ticket.overdue && <span className="overdue">OVERDUE</span>}</div><p>{ticket.customerName} · #{ticket.id}</p><small>{ticket.description}</small></div><div className="ticket-meta"><span>Response due<strong>{new Date(ticket.promisedResponseAt).toLocaleString()}</strong></span><span>Assigned to<strong>{ticket.assigneeName ?? 'Unassigned'}</strong></span><select aria-label={`Priority for ticket ${ticket.id}`} value={ticket.priority} onChange={(e) => void updateTicket(ticket.id, 'priority', e.target.value)}><option>URGENT</option><option>HIGH</option><option>NORMAL</option><option>LOW</option></select>{user.role === 'ADMIN' && <select aria-label={`Assignee for ticket ${ticket.id}`} value={ticket.assigneeId ?? ''} onChange={(e) => void assignTicket(ticket.id, e.target.value)}><option value="">Unassigned</option>{users.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.name} ({assignee.role})</option>)}</select>}<select aria-label={`Status for ticket ${ticket.id}`} value={ticket.status} onChange={(e) => void updateTicket(ticket.id, 'status', e.target.value)}><option>OPEN</option><option>PENDING</option><option>IN_PROGRESS</option><option>RESOLVED</option><option>CLOSED</option></select></div></article>)}</section>
      <footer className="pagination"><span>{total} active tickets</span><div><button disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><b>Page {page}</b><button disabled={page * 12 >= total} onClick={() => setPage(page + 1)}>Next</button></div></footer>
      {dashboard && dashboard.recentlyEscalated.length > 0 && <section className="recent"><p className="eyebrow">SYSTEM ACTIVITY</p><h2>Recently escalated</h2>{dashboard.recentlyEscalated.slice(0, 4).map((item) => <p key={`${item.ticket.id}-${item.occurredAt}`}>Ticket #{item.ticket.id} · {item.ticket.title}<span>{item.action === 'SLA_ESCALATION' ? 'Automatic' : 'Manual'} · {item.previousValue} → {item.newValue}</span></p>)}</section>}
    </main>{showCreate && <div className="modal-backdrop"><form className="modal" onSubmit={createTicket}><div className="modal-head"><div><p className="eyebrow">NEW WORK</p><h2>Create ticket</h2></div><button type="button" className="close" onClick={() => setShowCreate(false)}>×</button></div><label>Customer<input required value={newTicket.customerName} onChange={(e) => setNewTicket({ ...newTicket, customerName: e.target.value })} /></label><label>Title<input required value={newTicket.title} onChange={(e) => setNewTicket({ ...newTicket, title: e.target.value })} /></label><label>Description<textarea required rows={4} value={newTicket.description} onChange={(e) => setNewTicket({ ...newTicket, description: e.target.value })} /></label><label>Response due<input required type="datetime-local" value={newTicket.promisedResponseAt} onChange={(e) => setNewTicket({ ...newTicket, promisedResponseAt: e.target.value })} /></label><button className="primary" type="submit">Create ticket</button></form></div>}
  </div>
}

export default App
