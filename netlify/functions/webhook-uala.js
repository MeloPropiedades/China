// ============================================================
// Netlify Function: webhook-uala
// Recibe notificaciones de Ualá Bis cuando el pago cambia estado.
// APPROVED → descuenta stock, marca pedido como confirmado
// REJECTED → libera stockReservado, marca pedido como cancelado
// URL pública: /.netlify/functions/webhook-uala
// ============================================================

import admin from 'firebase-admin';

// URLs de Ualá Bis — SANDBOX (igual que crear-preferencia-uala.js)
const UALA_AUTH_URL = 'https://auth.developers.ar.ua.la/v2/api/auth/token';
const UALA_ORDER_BASE = 'https://checkout.developers.ar.ua.la/v2/api/checkout';

// Init Firebase Admin una sola vez (la function se reutiliza entre invocaciones)
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (e) {
    console.error('[Firebase init]', e);
  }
}
const db = admin.firestore();

// Obtiene access_token de Ualá para verificar el estado real de la orden
async function obtenerTokenUala() {
  const resp = await fetch(UALA_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.UALA_USERNAME,
      client_id: process.env.UALA_CLIENT_ID,
      client_secret_id: process.env.UALA_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  if (!resp.ok) throw new Error(`Auth falló: ${resp.status}`);
  const data = await resp.json();
  return data.access_token;
}

// Consulta el estado real de la orden en Ualá (no confiar solo en el payload del webhook)
async function verificarEstadoOrden(uuid) {
  try {
    const token = await obtenerTokenUala();
    const resp = await fetch(`${UALA_ORDER_BASE}/${uuid}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.status;
  } catch (e) {
    console.warn('[verificarEstadoOrden]', e.message);
    return null;
  }
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const { uuid, external_reference, status } = payload;

    console.log('[Webhook Ualá] recibido:', { uuid, external_reference, status });

    if (!external_reference || !status) {
      return { statusCode: 400, body: 'Missing uuid/external_reference/status' };
    }

    // SEGURIDAD: verificar el estado real consultando Ualá
    // Si falla la verificación, usar el status del webhook con una advertencia
    const statusVerificado = await verificarEstadoOrden(uuid);
    const statusReal = statusVerificado || status;

    if (statusVerificado && statusVerificado !== status) {
      console.warn('[Webhook Ualá] Status mismatch', { webhook: status, real: statusVerificado });
    }

    const pedidoRef = db.collection('pedidos').doc(external_reference);
    const pedidoSnap = await pedidoRef.get();

    if (!pedidoSnap.exists) {
      // Responder 200 igual (no queremos que Ualá reintente infinitamente)
      console.warn('[Webhook Ualá] Pedido no encontrado:', external_reference);
      return { statusCode: 200, body: 'Pedido no encontrado (ignorado)' };
    }

    const pedido = pedidoSnap.data();

    // Idempotencia: si ya está confirmado, no hacer nada
    if (pedido.estado === 'confirmado') {
      return { statusCode: 200, body: 'Ya confirmado' };
    }

    // === APPROVED → confirmar venta ===
    if (statusReal === 'APPROVED') {
      await db.runTransaction(async (tx) => {
        // Re-leer el pedido dentro de la transacción
        const freshSnap = await tx.get(pedidoRef);
        if (!freshSnap.exists) return;
        const freshPedido = freshSnap.data();
        if (freshPedido.estado === 'confirmado') return;

        // Leer todos los productos del pedido
        const prodRefs = [];
        for (const item of freshPedido.items || []) {
          const ref = db.collection('productos').doc(item.productoId);
          const snap = await tx.get(ref);
          if (snap.exists) prodRefs.push({ ref, data: snap.data(), item });
        }
        // Descontar stock + liberar reservado
        for (const { ref, data, item } of prodRefs) {
          const stockActual = Number(data.stock ?? 0);
          const resActual = Number(data.stockReservado ?? 0);
          tx.update(ref, {
            stock: Math.max(0, stockActual - item.qty),
            stockReservado: Math.max(0, resActual - item.qty),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        // Marcar pedido como confirmado
        tx.update(pedidoRef, {
          estado: 'confirmado',
          confirmadoAt: admin.firestore.FieldValue.serverTimestamp(),
          ualaUuid: uuid,
          metodoPago: 'tarjeta',
          confirmadoPor: 'webhook-uala'
        });
      });

      return { statusCode: 200, body: 'Pedido confirmado' };
    }

    // === REJECTED → cancelar y liberar stock ===
    if (statusReal === 'REJECTED') {
      await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(pedidoRef);
        if (!freshSnap.exists) return;
        const freshPedido = freshSnap.data();
        if (freshPedido.estado !== 'reservado') return;

        const prodRefs = [];
        for (const item of freshPedido.items || []) {
          const ref = db.collection('productos').doc(item.productoId);
          const snap = await tx.get(ref);
          if (snap.exists) prodRefs.push({ ref, data: snap.data(), item });
        }
        for (const { ref, data, item } of prodRefs) {
          const resActual = Number(data.stockReservado ?? 0);
          tx.update(ref, {
            stockReservado: Math.max(0, resActual - item.qty)
          });
        }
        tx.update(pedidoRef, {
          estado: 'cancelado',
          canceladoAt: admin.firestore.FieldValue.serverTimestamp(),
          canceladoPor: 'webhook-uala-rejected',
          ualaUuid: uuid
        });
      });

      return { statusCode: 200, body: 'Pedido cancelado (pago rechazado)' };
    }

    // Otros estados (PROCESSED, PENDING) → solo loguear
    return { statusCode: 200, body: `Estado ${statusReal} recibido (sin acción)` };

  } catch (e) {
    console.error('[webhook-uala]', e);
    // Devolver 500 para que Ualá reintente
    return { statusCode: 500, body: e.message };
  }
}
