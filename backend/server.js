// ============================================
// BACKEND NODE.JS - WHATSAPP WEB CON BAILEYS
// ============================================

// 1. CREAR CARPETA: backend/
// 2. COPIAR ESTE CÓDIGO EN: backend/server.js

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Logger
const logger = pino();

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Almacenar sesiones activas
const activeSessions = new Map();
const qrCodes = new Map();
const wsClients = new Map();

// ============================================
// FUNCIONES AUXILIARES
// ============================================

async function initializeWhatsApp(userId) {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(
      path.join(__dirname, `sessions/${userId}`)
    );

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Hoomi CRM', 'Safari', '1.0.0'],
    });

    // Evento: QR generado
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrImage = await QRCode.toDataURL(qr);
        qrCodes.set(userId, qrImage);
        
        // Notificar al frontend
        broadcastToUser(userId, {
          type: 'QR_GENERATED',
          qr: qrImage,
        });
      }

      if (connection === 'open') {
        logger.info(`WhatsApp conectado para ${userId}`);
        qrCodes.delete(userId);
        
        // Guardar sesión en Supabase
        await supabase.from('whatsapp_sessions').upsert({
          asesor_id: userId,
          status: 'connected',
          phone: sock.user?.id,
          last_activity: new Date(),
        });

        broadcastToUser(userId, {
          type: 'SESSION_CONNECTED',
          phone: sock.user?.id,
        });
      }

      if (connection === 'close') {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut;

        logger.info(
          `Conexión cerrada para ${userId}, reconectar: ${shouldReconnect}`
        );

        if (shouldReconnect) {
          initializeWhatsApp(userId);
        } else {
          activeSessions.delete(userId);
          await supabase.from('whatsapp_sessions').update({
            status: 'disconnected',
          }).eq('asesor_id', userId);
        }
      }
    });

    // Evento: Mensaje recibido
    sock.ev.on('messages.upsert', async (m) => {
      const message = m.messages[0];

      if (!message.key.fromMe && message.message) {
        const text =
          message.message.conversation ||
          message.message.extendedTextMessage?.text ||
          '';

        const phone = message.key.remoteJid.split('@')[0];

        // Guardar mensaje en Supabase
        await supabase.from('whatsapp_messages').insert({
          asesor_id: userId,
          phone,
          message: text,
          direction: 'incoming',
          timestamp: new Date(message.messageTimestamp * 1000),
          status: 'received',
        });

        // Buscar o crear lead
        const { data: lead } = await supabase
          .from('leads')
          .select('id')
          .eq('phone', phone)
          .eq('asesor_id', userId)
          .single();

        if (!lead) {
          await supabase.from('leads').insert({
            asesor_id: userId,
            phone,
            name: message.pushName || 'Contacto',
            source: 'whatsapp',
            status: 'prospecto',
          });
        }

        // Notificar al frontend
        broadcastToUser(userId, {
          type: 'MESSAGE_RECEIVED',
          phone,
          message: text,
          timestamp: new Date(),
        });
      }
    });

    activeSessions.set(userId, sock);
    return sock;
  } catch (error) {
    logger.error(`Error inicializando WhatsApp para ${userId}:`, error);
    throw error;
  }
}

function broadcastToUser(userId, data) {
  wsClients.forEach((client, id) => {
    if (id.startsWith(userId) && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// ============================================
// RUTAS API
// ============================================

// Iniciar sesión WhatsApp
app.post('/api/whatsapp/init', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId requerido' });
    }

    if (activeSessions.has(userId)) {
      return res.status(400).json({ error: 'Sesión ya activa' });
    }

    await initializeWhatsApp(userId);
    res.json({ success: true, message: 'Inicializando WhatsApp...' });
  } catch (error) {
    logger.error('Error en /api/whatsapp/init:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obtener QR
app.get('/api/whatsapp/qr/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const qr = qrCodes.get(userId);

    if (!qr) {
      return res.status(404).json({ error: 'QR no disponible' });
    }

    res.json({ qr });
  } catch (error) {
    logger.error('Error en /api/whatsapp/qr:', error);
    res.status(500).json({ error: error.message });
  }
});

// Enviar mensaje
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { userId, phone, message } = req.body;

    if (!userId || !phone || !message) {
      return res.status(400).json({ error: 'Parámetros requeridos' });
    }

    const sock = activeSessions.get(userId);
    if (!sock) {
      return res.status(400).json({ error: 'Sesión no activa' });
    }

    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });

    // Guardar en Supabase
    await supabase.from('whatsapp_messages').insert({
      asesor_id: userId,
      phone,
      message,
      direction: 'outgoing',
      timestamp: new Date(),
      status: 'sent',
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error en /api/whatsapp/send:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obtener mensajes de un contacto
app.get('/api/whatsapp/messages/:userId/:phone', async (req, res) => {
  try {
    const { userId, phone } = req.params;

    const { data: messages } = await supabase
      .from('whatsapp_messages')
      .select('*')
      .eq('asesor_id', userId)
      .eq('phone', phone)
      .order('timestamp', { ascending: true });

    res.json({ messages });
  } catch (error) {
    logger.error('Error en /api/whatsapp/messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obtener conversaciones
app.get('/api/whatsapp/conversations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: messages } = await supabase
      .from('whatsapp_messages')
      .select('phone, message, timestamp, direction')
      .eq('asesor_id', userId)
      .order('timestamp', { ascending: false });

    // Agrupar por teléfono
    const conversations = {};
    messages.forEach((msg) => {
      if (!conversations[msg.phone]) {
        conversations[msg.phone] = {
          phone: msg.phone,
          lastMessage: msg.message,
          lastTimestamp: msg.timestamp,
          unread: msg.direction === 'incoming' ? 1 : 0,
        };
      }
    });

    res.json({ conversations: Object.values(conversations) });
  } catch (error) {
    logger.error('Error en /api/whatsapp/conversations:', error);
    res.status(500).json({ error: error.message });
  }
});

// Estado de sesión
app.get('/api/whatsapp/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: session } = await supabase
      .from('whatsapp_sessions')
      .select('*')
      .eq('asesor_id', userId)
      .single();

    const hasQR = qrCodes.has(userId);
    const isActive = activeSessions.has(userId);

    res.json({
      status: session?.status || 'disconnected',
      phone: session?.phone,
      hasQR,
      isActive,
    });
  } catch (error) {
    logger.error('Error en /api/whatsapp/status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Desconectar
app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    const { userId } = req.body;

    const sock = activeSessions.get(userId);
    if (sock) {
      await sock.logout();
      activeSessions.delete(userId);
    }

    qrCodes.delete(userId);

    await supabase.from('whatsapp_sessions').update({
      status: 'disconnected',
    }).eq('asesor_id', userId);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error en /api/whatsapp/disconnect:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WEBSOCKET
// ============================================

wss.on('connection', (ws, req) => {
  const userId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('userId');
  
  if (userId) {
    wsClients.set(`${userId}-${Date.now()}`, ws);

    ws.on('close', () => {
      wsClients.delete(`${userId}-${Date.now()}`);
    });
  }
});

// ============================================
// INICIAR SERVIDOR
// ============================================

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`Servidor escuchando en puerto ${PORT}`);
});
