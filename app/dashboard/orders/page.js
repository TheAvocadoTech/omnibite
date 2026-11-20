'use client';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import Icon from '@/components/Icon';

const FLOW = ['Pending', 'Accepted', 'Preparing', 'Ready', 'Completed'];
const nextOf = (s) => FLOW[FLOW.indexOf(s) + 1];
const ago = (d) => { const m = Math.max(0, Math.round((Date.now() - new Date(d)) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`; };

export default function Orders() {
  const [orders, setOrders] = useState(null);
  const [view, setView] = useState('kanban');
  const [rid, setRid] = useState(null);
  const [cur, setCur] = useState('₹');
  const [info, setInfo] = useState(null);
  const [fresh, setFresh] = useState({});
  const [, tick] = useState(0);
  const audio = useRef(null);

  useEffect(() => {
    fetch('/api/orders').then((r) => r.json()).then((d) => setOrders(d.orders || []));
    fetch('/api/settings').then((r) => r.json()).then((d) => { setRid(d.restaurant._id); setCur(d.restaurant.currency); setInfo(d.restaurant); });
    const t = setInterval(() => tick((n) => n + 1), 30000); // refresh "x min ago"
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!rid) return;
    const s = io();
    s.on('connect', () => s.emit('join:restaurant', rid));
    s.on('order:new', (o) => {
      setOrders((p) => [o, ...(p || [])]);
      setFresh((f) => ({ ...f, [o._id]: true }));
      setTimeout(() => setFresh((f) => { const n = { ...f }; delete n[o._id]; return n; }), 4000);
      chime();
    });
    s.on('order:update', (o) => setOrders((p) => (p || []).map((x) => (x._id === o._id ? o : x))));
    return () => s.disconnect();
  }, [rid]);

  function chime() {
    try {
      const c = (audio.current ||= new (window.AudioContext || window.webkitAudioContext)());
      [880, 1175].forEach((f, i) => {
        const o = c.createOscillator(); const g = c.createGain();
        o.connect(g); g.connect(c.destination); o.frequency.value = f; g.gain.value = 0.12;
        o.start(c.currentTime + i * 0.18); o.stop(c.currentTime + i * 0.18 + 0.16);
      });
    } catch {}
  }

  async function setStatus(id, status) {
    setOrders((p) => p.map((x) => (x._id === id ? { ...x, status } : x))); // optimistic
    await fetch(`/api/orders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  }

  async function receipt(o) {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, L = 15, R = W - 15;
    const money = (n) => `Rs. ${Number(n || 0).toFixed(2)}`; // default PDF fonts have no rupee glyph
    const RED = [214, 40, 40], INK = [31, 20, 20], MUTED = [111, 99, 97], LINE = [234, 222, 220];
    const when = new Date(o.createdAt);
    const rest = info || {};

    // Header band
    doc.setFillColor(...RED); doc.rect(0, 0, W, 34, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(20);
    doc.text(rest.name || 'Restaurant', L, 16);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    const sub = [rest.address, rest.phone && `Ph: ${rest.phone}`].filter(Boolean).join('  |  ');
    if (sub) doc.text(doc.splitTextToSize(sub, 120), L, 23);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.text('ORDER STATEMENT', R, 16, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(`Order #${o.number}`, R, 23, { align: 'right' });

    // Order details
    let y = 46;
    doc.setTextColor(...INK);
    const field = (label, value, x) => {
      doc.setFontSize(8); doc.setTextColor(...MUTED); doc.text(label.toUpperCase(), x, y);
      doc.setFontSize(11); doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.text(String(value), x, y + 6); doc.setFont('helvetica', 'normal');
    };
    field('Order no.', `#${o.number}`, L);
    field('Table', o.table, L + 40);
    field('Date', when.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), L + 70);
    field('Time', when.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), L + 112);
    field('Status', o.status, L + 145);
    y += 16;
    if (o.customerName) { field('Customer', o.customerName, L); y += 16; }

    // Items table header
    y += 2;
    doc.setFillColor(253, 232, 230); doc.rect(L, y, R - L, 9, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...INK);
    doc.text('#', L + 3, y + 6); doc.text('ITEM', L + 12, y + 6);
    doc.text('QTY', 128, y + 6, { align: 'right' }); doc.text('RATE', 158, y + 6, { align: 'right' }); doc.text('AMOUNT', R - 3, y + 6, { align: 'right' });
    y += 9; doc.setFont('helvetica', 'normal');

    const newPage = () => { doc.addPage(); y = 20; };
    o.items.forEach((i, k) => {
      const extra = [i.size && `Size: ${i.size}`, i.addons?.length && `Add-ons: ${i.addons.join(', ')}`, i.note && `Note: ${i.note}`].filter(Boolean);
      const nameLines = doc.splitTextToSize(i.name || '', 85);
      const h = 5 + nameLines.length * 5 + extra.length * 4 + 2;
      if (y + h > 265) newPage();
      doc.setFontSize(10); doc.setTextColor(...INK);
      doc.text(String(k + 1), L + 3, y + 6);
      doc.text(nameLines, L + 12, y + 6);
      doc.text(String(i.qty), 128, y + 6, { align: 'right' });
      doc.text(money(i.price), 158, y + 6, { align: 'right' });
      doc.text(money(i.qty * i.price), R - 3, y + 6, { align: 'right' });
      let yy = y + 6 + (nameLines.length - 1) * 5;
      doc.setFontSize(8); doc.setTextColor(...MUTED);
      extra.forEach((t) => { yy += 4; doc.text(doc.splitTextToSize(t, 90), L + 12, yy); });
      y += h + 2;
      doc.setDrawColor(...LINE); doc.line(L, y, R, y);
    });

    // Totals
    if (y + 40 > 275) newPage();
    y += 8;
    const row = (label, value, bold) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 13 : 10); doc.setTextColor(...INK);
      doc.text(label, 130, y); doc.text(value, R - 3, y, { align: 'right' }); y += bold ? 8 : 6;
    };
    row('Subtotal', money(o.subtotal));
    row(`Tax${rest.taxRate != null ? ` (${rest.taxRate}%)` : ''}`, money(o.tax));
    doc.setDrawColor(...RED); doc.setLineWidth(0.5); doc.line(130, y - 2, R, y - 2); y += 4;
    row('TOTAL', money(o.total), true);

    // Footer
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
    doc.text('Thank you for dining with us!', W / 2, 280, { align: 'center' });
    doc.setFontSize(8); doc.text('Powered by OmniBite by Avocado Technologies', W / 2, 285, { align: 'center' });
    doc.save(`order-${o.number}.pdf`);
  }

  if (!orders) return <div className="skel" style={{ height: 320 }} />;

  const active = orders.filter((o) => !['Completed', 'Cancelled'].includes(o.status));
  const actions = (o) => (
    <div className="row" style={{ gap: '.35rem' }}>
      {nextOf(o.status) && o.status !== 'Cancelled' && <button className="btn sm" onClick={() => setStatus(o._id, nextOf(o.status))}>{nextOf(o.status)} <Icon name="arrow" size={13} /></button>}
      {['Pending', 'Accepted'].includes(o.status) && <button className="btn danger sm" onClick={() => setStatus(o._id, 'Cancelled')}>Cancel</button>}
      <button className="btn ghost sm" onClick={() => receipt(o)} title="Download receipt"><Icon name="download" size={13} /> PDF</button>
    </div>
  );
  const card = (o) => (
    <div key={o._id} className={`kcard ${fresh[o._id] ? 'fresh' : ''}`}>
      <div className="row spread"><b>#{o.number} · Table {o.table}</b><span className="muted"><Icon name="clock" size={12} /> {ago(o.createdAt)}</span></div>
      {o.customerName && <div className="muted">{o.customerName}</div>}
      <div style={{ margin: '.45rem 0' }}>{o.items.map((i, k) => <div key={k}>{i.qty}× <b>{i.name}</b>{i.size && ` (${i.size})`}{(i.addons?.length > 0 || i.note) && <div className="muted">{[...(i.addons || []), i.note && `“${i.note}”`].filter(Boolean).join(' · ')}</div>}</div>)}</div>
      <div className="row spread"><b>{cur}{o.total}</b>{actions(o)}</div>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div><h1>Orders · Kitchen Display</h1><p><span className="live-dot" /> Live. New orders appear instantly. {active.length} active.</p></div>
        <div className="tabs"><button className={view === 'kanban' ? 'on' : ''} onClick={() => setView('kanban')}>Kanban</button><button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button></div>
      </div>
      {view === 'kanban' ? (
        <div className="kanban">{FLOW.slice(0, 4).map((st) => {
          const list = active.filter((o) => o.status === st);
          return <div className="kcol" key={st}><div className="kcol-h"><span>{st}</span><span className={`badge ${st}`}>{list.length}</span></div>{list.map(card)}{!list.length && <div className="muted" style={{ textAlign: 'center', padding: '1rem' }}>No orders</div>}</div>;
        })}</div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}><table>
          <thead><tr><th>#</th><th>Table</th><th>Items</th><th>Total</th><th>Status</th><th>Time</th><th /></tr></thead>
          <tbody>{orders.slice(0, 100).map((o) => (
            <tr key={o._id}><td><b>{o.number}</b></td><td>{o.table}</td><td>{o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</td><td>{cur}{o.total}</td><td><span className={`badge ${o.status}`}>{o.status}</span></td><td className="muted">{new Date(o.createdAt).toLocaleString()}</td><td>{actions(o)}</td></tr>))}</tbody>
        </table></div>
      )}
    </>
  );
}
