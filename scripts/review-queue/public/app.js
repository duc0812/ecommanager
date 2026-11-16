'use strict'

const TABS = [
  { key: 'waiting', label: 'Chờ duyệt', statuses: ['waiting'] },
  { key: 'qa_failed', label: 'Lỗi QA', statuses: ['qa_failed'] },
  { key: 'rejected', label: 'Bị trả lại', statuses: ['rejected'] },
  { key: 'fixing', label: 'Agent đang sửa', statuses: ['fixing'] },
  { key: 'needs_look', label: 'Prod đã thay đổi', statuses: ['needs_look'] },
  { key: 'done', label: 'Đã xong', statuses: ['approved', 'cloud', 'held', 'removed'] },
]
const CHIP = {
  waiting: ['Chờ duyệt', ''], rejected: ['Bị trả lại', 'rej'], fixing: ['Agent đang sửa', 'fix'], qa_failed: ['Lỗi QA', 'qa'],
  needs_look: ['Prod đã thay đổi', 'look'], approved: ['Đã duyệt', 'ok'], cloud: ['Lên cloud', 'cloud'], held: ['Đã báo /hold', 'held'],
  removed: ['Đã bỏ', 'gone'],
}
const REFRESH_MS = 15_000
const SOON_MS = 30 * 60_000

const S = {
  tab: 'waiting', items: [], counts: {}, approvedToday: 0, selected: null, detail: null,
  viewVersion: null, part: 0, side: 'customer', busy: false, notice: null, menu: false, loadedTab: false,
}

const $ = id => document.getElementById(id)
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const pad = n => String(n).padStart(2, '0')
const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}` }
const fmtTime = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const fmtDateTime = iso => `${fmtDate(iso)} ${fmtTime(iso)}`
const fmtBytes = b => (b == null ? '' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
const tabOf = status => TABS.find(t => t.statuses.includes(status))?.key ?? 'done'
const safeUrl = u => {
  if (typeof u !== 'string' || !u) return null
  if (u.startsWith('/files/')) return u
  try {
    const x = new URL(u)
    return x.protocol === 'https:' || x.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}
const needsForce = item => item.status === 'qa_failed' || item.qa?.verdict === 'fail'

function left(deadline, withSeconds) {
  const ms = Date.parse(deadline) - Date.now()
  if (ms <= 0) return null
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return withSeconds ? `${h}:${pad(m)}:${pad(s % 60)}` : `${h}:${pad(m)}`
}

function countdownText(item) {
  if (!item.deadline) return ''
  const l = left(item.deadline, false)
  const what = item.status === 'qa_failed' ? 'báo /hold' : 'lên cloud'
  return l ? `còn ${l} rồi ${what}` : `quá hạn — chờ tick ${what}`
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts)
  let body = null
  try { body = await res.json() } catch { body = { ok: false, error: `HTTP ${res.status}` } }
  return body
}

const post = (id, action, body) => api(`/api/items/${encodeURIComponent(id)}/${action}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Queue': '1' }, body: JSON.stringify(body ?? {}),
})

function toast(text, kind = '') {
  const t = $('toast')
  t.textContent = text
  t.className = `toast ${kind}`
  t.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { t.hidden = true }, kind === 'bad' ? 9000 : 5000)
}

async function loadList() {
  const tab = TABS.find(t => t.key === S.tab)
  const r = await api(`/api/items?status=${tab.statuses.join(',')}`)
  if (!r.items) return
  S.items = r.items
  S.counts = r.counts ?? {}
  S.approvedToday = r.approvedToday ?? 0
  if (!S.loadedTab) {
    S.loadedTab = true
    if (!S.items.length) {
      const first = TABS.find(t => t.key !== 'done' && (S.counts[t.statuses[0]] ?? 0) > 0)
      if (first) { S.tab = first.key; return loadList() }
    }
  }
  if (!S.items.some(i => i.id === S.selected)) S.selected = S.items[0]?.id ?? null
}

async function loadDetail() {
  if (!S.selected) { S.detail = null; return }
  const r = await api(`/api/items/${encodeURIComponent(S.selected)}`)
  if (!r.item) { S.detail = null; return }
  const before = S.detail?.item?.id === r.item.id ? S.detail.item.version : null
  if (before != null && before !== r.item.version) {
    S.notice = { kind: '', text: `Đã có bản mới v${r.item.version} — xem lại trước khi duyệt` }
    S.viewVersion = null
    S.part = 0
  }
  if (S.detail?.item?.id !== r.item.id) { S.viewVersion = null; S.part = 0; S.side = r.images?.customer ? 'customer' : 'store' }
  S.detail = r
}

async function refresh() {
  await loadList()
  await loadDetail()
  render()
}

function select(id) {
  if (!id || S.busy) return
  if (id !== S.selected) S.notice = null
  S.selected = id
  S.menu = false
  loadDetail().then(render)
}

function move(step) {
  const i = S.items.findIndex(x => x.id === S.selected)
  const next = S.items[Math.min(S.items.length - 1, Math.max(0, (i < 0 ? 0 : i + step)))]
  if (next) select(next.id)
}

function renderHeader() {
  const c = S.counts
  $('stats').textContent = `Chờ duyệt ${c.waiting ?? 0} · Lỗi QA ${c.qa_failed ?? 0} · Agent đang sửa ${c.fixing ?? 0} · Đã duyệt hôm nay ${S.approvedToday}`
  $('tabs').innerHTML = TABS.map(t => {
    const n = t.key === 'done' ? '' : ` ${t.statuses.reduce((a, s) => a + (S.counts[s] ?? 0), 0)}`
    return `<button class="tab${t.key === S.tab ? ' on' : ''}" data-tab="${t.key}">${esc(t.label)}${n}</button>`
  }).join('')
}

function chipOf(item) {
  const [label, cls] = CHIP[item.status] ?? [item.status, '']
  let text = label
  if (item.status === 'qa_failed' && item.qa?.items?.length) text = `${label} · ${item.qa.items[0]}`
  else if (item.status === 'rejected' && item.statusReason) text = `${label} · ${item.statusReason}`
  return `<span class="chip ${cls}" title="${esc(item.statusReason ?? text)}">${esc(text)}</span>`
}

function renderList() {
  if (!S.items.length) { $('list').innerHTML = '<div class="empty">Không có dòng nào ở mục này.</div>'; return }
  $('list').innerHTML = S.items.map(i => {
    const soon = i.deadline && Date.parse(i.deadline) - Date.now() < SOON_MS
    const thumb = safeUrl(i.thumb)
    const img = thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : '<div class="noimg"></div>'
    const sub = [i.title, i.variant].filter(Boolean).join(' · ')
    const extra = i.qa?.count && i.status !== 'qa_failed' ? `<span class="cd">${i.qa.count} đề xuất sửa</span>` : ''
    const done = tabOf(i.status) === 'done' ? `<span class="cd">${esc(fmtDateTime(i.updatedAt))}</span>` : ''
    return `<div class="it${i.id === S.selected ? ' on' : ''}" data-id="${esc(i.id)}">${img}<div>
      <div class="k">${esc(i.taskKey)}${i.kind === 'group' ? ' <span class="cd">(nhóm)</span>' : ''}</div>
      <div class="t" title="${esc(sub)}">${esc(sub || '—')} · v${i.version}</div>
      <div class="row">${chipOf(i)}${i.deadline ? `<span class="cd${soon ? ' soon' : ''}" data-deadline="${esc(i.deadline)}" data-status="${esc(i.status)}">${esc(countdownText(i))}</span>` : ''}${extra}${done}</div>
    </div></div>`
  }).join('')
}

function viewed() {
  const d = S.detail
  const n = S.viewVersion ?? d.item.version
  return d.versions.find(v => v.n === n) ?? d.versions[d.versions.length - 1] ?? { n, files: [], qa: null }
}

function imgCard({ title, right, href, src: rawSrc, cls = '', footer = '', empty }) {
  const src = safeUrl(rawSrc)
  const link = safeUrl(href ?? rawSrc)
  const img = src ? `<img class="big" src="${esc(src)}" alt="">` : ''
  const body = !src
    ? `<div class="noimg big">${esc(empty ?? 'Không có ảnh')}</div>`
    : link ? `<a class="img" href="${esc(link)}" target="_blank" rel="noopener" title="Bấm để xem gốc">${img}</a>` : img
  return `<div class="card ${cls}"><h3>${esc(title)} <span>${esc(right ?? '')}</span></h3>${body}${footer}</div>`
}

function renderDetail() {
  const d = S.detail
  if (!d) { $('detail').innerHTML = '<div class="empty">Chọn một dòng bên trái.</div>'; return }
  const it = d.item
  const m = it.meta ?? {}
  const v = viewed()
  const files = v.files ?? []
  const part = files[Math.min(S.part, Math.max(0, files.length - 1))]
  const mock = files.find(f => f.kind === 'MOCKUP')
  const sub = [
    m.orderNumber, m.placedAt ? fmtDate(m.placedAt) : null, m.variantTitle, m.sku ? `SKU ${m.sku}` : null,
    m.supplierSku ? `SKU xưởng ${m.supplierSku}` : null, `bản v${it.version}`,
  ].filter(Boolean).join(' · ')

  let clock
  if (it.deadline) {
    const l = left(it.deadline, true)
    const label = it.status === 'qa_failed' ? 'Tự báo /hold (Lỗi QA) sau' : 'Tự lên cloud (Chờ duyệt) sau'
    clock = `<div class="clock"><div class="cd">${label}</div><b id="clock" data-deadline="${esc(it.deadline)}">${esc(l ?? 'quá hạn')}</b></div>`
  } else {
    clock = `<div class="clock"><div class="cd">Không tính giờ</div><b>${esc((CHIP[it.status] ?? [it.status])[0])}</b></div>`
  }

  const notices = []
  if (S.notice) notices.push(`<div class="notice ${S.notice.kind}">${esc(S.notice.text)}</div>`)
  if (v.n !== it.version) notices.push(`<div class="notice info">Đang xem bản cũ v${v.n} — các nút áp dụng cho bản hiện tại v${it.version}.</div>`)
  if (it.status === 'rejected' && it.statusReason) notices.push(`<div class="notice bad">Bị trả lại: ${esc(it.statusReason)}</div>`)
  if (it.status === 'fixing') {
    const job = [...d.jobs].reverse().find(j => j.status === 'running' || j.status === 'queued')
    notices.push(`<div class="notice info">Agent đang sửa${job ? ` (${esc(job.agent)}, job ${job.n}, ${job.status === 'queued' ? 'đang chờ lượt' : 'đang chạy'})` : ''}: ${esc(job?.reason || it.statusReason || '')}</div>`)
  }
  if (it.status === 'needs_look') notices.push(`<div class="notice">Prod đã thay đổi — cần xem: ${esc(it.statusReason ?? '')}</div>`)
  if (tabOf(it.status) === 'done' && it.statusReason) notices.push(`<div class="notice info">${esc((CHIP[it.status] ?? [it.status])[0])}: ${esc(it.statusReason)}</div>`)

  const partInfo = part ? [part.width && part.height ? `${part.width}×${part.height} px` : null, fmtBytes(part.bytes), 'bấm để xem gốc'].filter(Boolean).join(' · ') : ''
  const partTabs = files.length > 1 ? `<div class="parts">${files.map((f, i) => `<button data-part="${i}" class="${f === part ? 'on' : ''}">${esc(f.part)}</button>`).join('')}</div>` : ''
  const sides = [['customer', 'Khách đặt'], ['store', 'Store']].filter(([k]) => d.images[k])
  const sideImg = d.images[S.side] ?? d.images.customer ?? d.images.store
  const sideTabs = sides.length > 1 ? `<div class="parts">${sides.map(([k, l]) => `<button data-side="${k}" class="${d.images[S.side] === d.images[k] ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''

  const custom = (m.custom ?? []).map(f => `<div><dt>${esc(f.name)}</dt><dd>${esc(f.value)}</dd></div>`).join('')
  const facts = [
    ['Sản phẩm', m.productTitle], ['Biến thể', m.variantTitle], ['SKU', m.sku], ['SKU xưởng', m.supplierSku],
    ['Các dòng', d.memberKeys.length > 1 ? d.memberKeys.join(', ') : null], ['Nguồn', m.sourceCli],
  ].filter(([, x]) => x).map(([k, x]) => `<div><dt>${esc(k)}</dt><dd>${esc(x)}</dd></div>`).join('')

  const qa = v.qa ?? it.qa ?? { verdict: 'unchecked', items: [] }
  const qaItems = (qa.items ?? []).map(x => `<li class="w">! ${esc(x)}</li>`).join('')
  const qaHead = qa.verdict === 'pass' ? '<li class="ok">✓ Qua kiểm tra máy</li>' : qa.verdict === 'fail' ? '<li class="w">Kiểm tra máy báo lỗi</li>' : '<li class="mute">Chưa có kiểm tra máy cho bản này</li>'
  const versions = d.versions.map(x => `<button data-ver="${x.n}" class="${x.n === v.n ? 'on' : ''}" title="${esc(fmtDateTime(x.createdAt))}">v${x.n}</button>`).join('')
  const hist = d.events.slice(-14).map(e => `<div>${esc(fmtDateTime(e.createdAt))} · ${esc(e.message)}</div>`).join('')

  $('detail').innerHTML = `
  <div class="top"><div><h1>${esc(it.taskKey)}${m.productTitle ? ` · ${esc(m.productTitle)}` : ''}</h1><div class="sub">${esc(sub)}</div></div><span class="sp"></span>${clock}</div>
  ${notices.join('')}
  <div class="grid">
    ${imgCard({ title: `File in · ${part?.part ?? ''}`, right: partInfo, href: part?.url, src: part?.previewUrl ?? null, footer: partTabs, empty: part ? 'Không có ảnh xem trước' : 'Bản này không có file' })}
    ${imgCard({ title: 'Mockup từ file in', right: mock?.fileName ?? '', href: mock?.url, src: mock?.previewUrl ?? null, cls: 'small', empty: 'Chưa có mockup' })}
    ${imgCard({ title: 'Ảnh khách đặt / mockup store', right: sideImg ? (sideImg.url.startsWith('/files/') ? 'từ ổ đĩa' : 'link') : '', href: sideImg?.original, src: sideImg?.url ?? null, cls: 'small', footer: sideTabs, empty: 'Không có ảnh khách đặt' })}
  </div>
  <div class="info">
    <div class="card"><h3>Thông tin custom <span>${d.memberKeys.length > 1 ? `nhóm ${d.memberKeys.length} dòng` : ''}</span></h3><dl class="kv">${custom || '<div><dd class="cd">Không có thông tin custom</dd></div>'}${facts}</dl></div>
    <div class="card"><h3>Agent QA <span>đề xuất sửa</span></h3><ul class="qa">${qaHead}${qaItems}</ul>
      <div class="vers"><span class="cd">Các bản:</span>${versions}</div>
      <div class="hist">${hist}</div></div>
  </div>`
}

function renderBar() {
  const d = S.detail
  const bar = $('bar')
  if (!d) { bar.innerHTML = '<span class="keys">← → chuyển dòng · D duyệt · T trả lại</span>'; return }
  const it = d.item
  const dis = S.busy ? ' disabled' : ''
  const keys = '<span class="sp"></span><span class="keys">← → chuyển dòng · D duyệt · T trả lại</span>'
  const busy = S.busy ? `<span class="msg">${esc(S.busy)}</span>` : ''
  const menu = S.menu ? '<div class="menu"><button data-agent="claude">Claude</button><button data-agent="codex">Codex</button></div>' : ''
  const fixBtn = `<span class="menuwrap"><button class="btn ai" data-act="menu"${dis}>Gọi Agent sửa ▾ <small>Claude | Codex</small></button>${menu}</span>`
  if (['waiting', 'rejected', 'qa_failed'].includes(it.status)) {
    const approve = needsForce(it)
      ? `<button class="btn warn" data-act="approve"${dis}>Duyệt dù có lỗi <small>D</small></button>`
      : `<button class="btn ok" data-act="approve"${dis}>Duyệt <small>D</small></button>`
    bar.innerHTML = `${approve}<button class="btn bad" data-act="reject"${dis}>Trả lại <small>T</small></button>${fixBtn}
      <button class="btn" data-act="cloud"${dis}>Cho lên cloud ngay</button><button class="btn" data-act="remove"${dis}>Bỏ khỏi hàng chờ</button>${busy}${keys}`
  } else if (it.status === 'needs_look') {
    bar.innerHTML = `<button class="btn" data-act="remove"${dis}>Bỏ khỏi hàng chờ</button><button class="btn" data-act="rerun"${dis}>Lập lại từ snapshot mới</button>${busy}${keys}`
  } else if (it.status === 'fixing') {
    bar.innerHTML = `<span class="msg">Agent đang sửa — chờ bản mới (tối đa 60 phút)</span>${keys}`
  } else {
    bar.innerHTML = `<span class="msg">Đã xong: ${esc((CHIP[it.status] ?? [it.status])[0])}${it.statusReason ? ` — ${esc(it.statusReason)}` : ''}</span>${keys}`
  }
}

function render() {
  renderHeader()
  renderList()
  renderDetail()
  renderBar()
}

function modal(html, onOk) {
  const bg = $('modal')
  bg.innerHTML = `<div class="modal">${html}</div>`
  bg.hidden = false
  const close = () => { bg.hidden = true; bg.innerHTML = '' }
  bg.querySelector('[data-m="cancel"]')?.addEventListener('click', close)
  bg.querySelector('[data-m="ok"]')?.addEventListener('click', async () => {
    const r = await onOk?.(bg)
    if (r !== false) close()
  })
  const first = bg.querySelector('textarea') ?? bg.querySelector('[data-m="ok"]')
  first?.focus()
  return close
}
const modalOpen = () => !$('modal').hidden

async function act(action, body, { okText } = {}) {
  const it = S.detail?.item
  if (!it || S.busy) return
  const idx = S.items.findIndex(x => x.id === it.id)
  S.busy = action === 'approve' ? 'Đang duyệt và giao lên prod…' : action === 'cloud' ? 'Đang giao lên cloud…' : 'Đang xử lý…'
  S.menu = false
  renderBar()
  let r
  try {
    r = await post(it.id, action, body)
  } catch (e) {
    r = { ok: false, error: `Không gọi được server: ${e}` }
  }
  S.busy = false
  if (r.ok) {
    S.notice = null
    const label = r.status ? ` → ${(CHIP[r.status] ?? [r.status])[0]}` : ''
    toast(`${it.taskKey}: ${okText ?? r.message ?? 'xong'}${label}`, r.status === 'approved' || r.status === 'fixing' ? 'ok' : '')
    await loadList()
    if (!S.items.some(x => x.id === it.id)) S.selected = (S.items[idx] ?? S.items[idx - 1] ?? S.items[0])?.id ?? null
    await loadDetail()
    render()
    return
  }
  if (r.code === 'version_changed') {
    await loadDetail()
    S.notice = { kind: '', text: `Đã có bản mới v${r.version ?? S.detail?.item?.version} — xem lại trước khi duyệt` }
    S.viewVersion = null
    await loadList()
    render()
    return
  }
  toast(`${it.taskKey}: ${r.error ?? 'không làm được'}`, 'bad')
  await refresh()
  S.notice = { kind: 'bad', text: r.error ?? 'không làm được' }
  render()
}

function qaList(it) {
  const items = it.qa?.items ?? []
  return items.length ? `<ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''
}

function onApprove() {
  const it = S.detail?.item
  if (!it || !['waiting', 'rejected', 'qa_failed'].includes(it.status)) return
  if (needsForce(it)) {
    modal(`<h2>Duyệt dù có lỗi QA?</h2><p>${esc(it.taskKey)} v${it.version} — kiểm tra máy báo:</p>${qaList(it)}
      <p>Dòng sẽ lên prod ở <b>Đã duyệt</b>.</p>
      <div class="acts"><button class="btn" data-m="cancel">Huỷ</button><button class="btn warn" data-m="ok">Vẫn duyệt</button></div>`,
    () => { act('approve', { version: it.version, force: true }) })
    return
  }
  act('approve', { version: it.version })
}

function onReject() {
  const it = S.detail?.item
  if (!it || !['waiting', 'rejected', 'qa_failed'].includes(it.status)) return
  modal(`<h2>Trả lại ${esc(it.taskKey)} (v${it.version})</h2><p>Dòng ở lại hàng chờ, không tính giờ cho tới khi có bản mới.</p>
    <textarea id="reason" placeholder="Lý do (bắt buộc)"></textarea>
    <div class="acts"><button class="btn" data-m="cancel">Huỷ</button><button class="btn bad" data-m="ok">Trả lại</button></div>`,
  bg => {
    const reason = bg.querySelector('#reason').value.trim()
    if (!reason) { bg.querySelector('#reason').focus(); return false }
    act('reject', { version: it.version, reason }, { okText: 'đã trả lại' })
  })
}

function onFix(agent) {
  const it = S.detail?.item
  if (!it) return
  S.menu = false
  renderBar()
  const hasQa = (it.qa?.items ?? []).length > 0
  modal(`<h2>Gọi Agent sửa ${esc(it.taskKey)} (v${it.version})</h2>
    <div class="agents"><label><input type="radio" name="agent" value="claude"${agent === 'claude' ? ' checked' : ''}> Claude</label>
    <label><input type="radio" name="agent" value="codex"${agent === 'codex' ? ' checked' : ''}> Codex</label></div>
    ${hasQa ? `<p>Đề xuất sửa của kiểm tra máy (gửi kèm):</p>${qaList(it)}` : ''}
    <textarea id="reason" placeholder="Cần sửa gì${hasQa ? ' (có thể để trống, agent làm theo đề xuất ở trên)' : ' (bắt buộc)'}"></textarea>
    <p>Agent chạy nền, tối đa 60 phút; xong thì thành bản mới và đếm lại 3 giờ.</p>
    <div class="acts"><button class="btn" data-m="cancel">Huỷ</button><button class="btn ai" data-m="ok">Gọi agent</button></div>`,
  bg => {
    const reason = bg.querySelector('#reason').value.trim()
    const picked = bg.querySelector('input[name="agent"]:checked')?.value ?? agent
    if (!reason && !hasQa) { bg.querySelector('#reason').focus(); return false }
    act('fix', { version: it.version, agent: picked, reason }, { okText: `đã gọi ${picked === 'codex' ? 'Codex' : 'Claude'}` })
  })
}

function onCloud() {
  const it = S.detail?.item
  if (!it) return
  const force = needsForce(it)
  modal(`<h2>Cho lên cloud ngay?</h2><p>${esc(it.taskKey)} v${it.version} lên prod ở <b>Chờ duyệt</b> (như khi hết 3 giờ).</p>
    ${force ? `<p><b>Dòng có lỗi QA:</b></p>${qaList(it)}` : ''}
    <div class="acts"><button class="btn" data-m="cancel">Huỷ</button><button class="btn ${force ? 'warn' : 'ok'}" data-m="ok">${force ? 'Vẫn cho lên cloud' : 'Cho lên cloud'}</button></div>`,
  () => { act('cloud', { version: it.version, ...(force ? { force: true } : {}) }) })
}

function onRemove() {
  const it = S.detail?.item
  if (!it) return
  modal(`<h2>Bỏ ${esc(it.taskKey)} khỏi hàng chờ?</h2><p>Không giao gì lên prod. Task trên prod giữ nguyên trạng thái hiện tại.</p>
    <div class="acts"><button class="btn" data-m="cancel">Huỷ</button><button class="btn bad" data-m="ok">Bỏ khỏi hàng chờ</button></div>`,
  () => { act('remove', { version: it.version }, { okText: 'đã bỏ khỏi hàng chờ' }) })
}

function onRerun() {
  const d = S.detail
  if (!d?.rerun) return
  modal(`<h2>Lập lại từ snapshot mới</h2><p>Lấy snapshot prod mới, rồi chạy lệnh này trong thư mục của script đẩy. File không đổi thì hàng chờ giữ nguyên dòng này — khi đó bấm "Bỏ khỏi hàng chờ" trước rồi chạy lại.</p>
    <pre id="cmd">${esc(d.rerun)}</pre>
    <div class="acts"><button class="btn" data-m="cancel">Đóng</button><button class="btn" data-m="ok">Chép lệnh</button></div>`,
  async () => {
    try { await navigator.clipboard.writeText(d.rerun); toast('Đã chép lệnh') } catch { toast('Không chép được — bôi đen lệnh để chép', 'bad') }
  })
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-tab],[data-id],[data-act],[data-agent],[data-part],[data-side],[data-ver]')
  if (!t) { if (S.menu) { S.menu = false; renderBar() } return }
  if (S.busy) return
  if (t.dataset.tab) {
    S.tab = t.dataset.tab
    S.selected = null
    S.notice = null
    refresh()
  } else if (t.dataset.id) select(t.dataset.id)
  else if (t.dataset.part) { S.part = Number(t.dataset.part); renderDetail() }
  else if (t.dataset.side) { S.side = t.dataset.side; renderDetail() }
  else if (t.dataset.ver) { S.viewVersion = Number(t.dataset.ver); S.part = 0; renderDetail() }
  else if (t.dataset.agent) onFix(t.dataset.agent)
  else if (t.dataset.act) {
    const a = t.dataset.act
    if (a === 'menu') { S.menu = !S.menu; renderBar() }
    else if (a === 'approve') onApprove()
    else if (a === 'reject') onReject()
    else if (a === 'cloud') onCloud()
    else if (a === 'remove') onRemove()
    else if (a === 'rerun') onRerun()
  }
})

document.addEventListener('keydown', e => {
  if (modalOpen()) {
    if (e.key === 'Escape') { $('modal').hidden = true; $('modal').innerHTML = '' }
    return
  }
  if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName ?? '')) return
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if ((e.key === 'd' || e.key === 'D') && !S.busy) onApprove()
  else if ((e.key === 't' || e.key === 'T') && !S.busy) { e.preventDefault(); onReject() }
  else if (e.key === 'Escape' && S.menu) { S.menu = false; renderBar() }
})

setInterval(() => {
  for (const el of document.querySelectorAll('.it .cd[data-deadline]')) {
    const item = { deadline: el.dataset.deadline, status: el.dataset.status }
    el.textContent = countdownText(item)
    el.classList.toggle('soon', Date.parse(item.deadline) - Date.now() < SOON_MS)
  }
  const c = $('clock')
  if (c) c.textContent = left(c.dataset.deadline, true) ?? 'quá hạn'
}, 1000)

setInterval(() => { if (!S.busy && !modalOpen()) refresh() }, REFRESH_MS)

refresh()
