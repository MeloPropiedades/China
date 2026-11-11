// ============================================================
// Netlify Function: crear-preferencia-uala
// Crea una orden de pago en Ualá Bis y devuelve la URL de checkout
// URL pública: /.netlify/functions/crear-preferencia-uala
// ============================================================

// URLs de Ualá Bis — SANDBOX (para pasar a prod: quitar ".stage" de ambas URLs)
const UALA_AUTH_URL = 'https://auth.stage.developers.ar.ua.la/v2/api/auth/token';
const UALA_CHECKOUT_URL = 'https://checkout.stage.developers.ar.ua.la/v2/api/checkout';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

export async function handler(event) {
  // Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { items, total, pedidoId, siteUrl } = body;

    if (!total || !pedidoId || !siteUrl) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Faltan datos obligatorios: total, pedidoId, siteUrl' })
      };
    }

    // 1. Obtener access_token
    const authResp = await fetch(UALA_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: process.env.UALA_USERNAME,
        client_id: process.env.UALA_CLIENT_ID,
        client_secret_id: process.env.UALA_CLIENT_SECRET,
        grant_type: 'client_credentials'
      })
    });

    if (!authResp.ok) {
      const errText = await authResp.text();
      console.error('[Ualá Auth]', authResp.status, errText);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Error autenticando con Ualá Bis (${authResp.status})` })
      };
    }

    const { access_token } = await authResp.json();

    // 2. Crear orden en Ualá Bis
    // Monto en centavos como string (ej: $35.000 → "3500000")
        const amountPesos = Number(total).toFixed(2);

    // Descripción con conteo de items
    const nItems = Array.isArray(items) ? items.reduce((a, c) => a + (c.qty || 1), 0) : 0;
    const descripcion = `China Mates · ${nItems} item${nItems !== 1 ? 's' : ''} · Pedido #${pedidoId.slice(-6).toUpperCase()}`;

    const checkoutResp = await fetch(UALA_CHECKOUT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${access_token}`
      },
      body: JSON.stringify({
        amount: amountPesos,
        description: descripcion.slice(0, 200),
        callback_success: `${siteUrl}/pago-exito.html?pedido=${pedidoId}`,
        callback_fail: `${siteUrl}/pago-fallo.html?pedido=${pedidoId}`,
        notification_url: `${siteUrl}/.netlify/functions/webhook-uala`,
        external_reference: pedidoId
      })
    });

    if (!checkoutResp.ok) {
      const errText = await checkoutResp.text();
      console.error('[Ualá Checkout]', checkoutResp.status, errText);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Error creando orden en Ualá Bis (${checkoutResp.status})` })
      };
    }

    const checkoutData = await checkoutResp.json();
    const checkoutLink = checkoutData?.links?.checkout_link || checkoutData?.links?.checkout;

    if (!checkoutLink) {
      console.error('[Ualá Checkout] Sin checkout_link:', checkoutData);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Ualá Bis no devolvió link de checkout' })
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        checkoutLink,
        uuid: checkoutData.uuid
      })
    };

  } catch (e) {
    console.error('[crear-preferencia-uala]', e);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: e.message || 'Error interno' })
    };
  }
}
