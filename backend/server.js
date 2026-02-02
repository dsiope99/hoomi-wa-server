// ============================================
// BACKEND NODE.JS - WHATSAPP WEB CON BAILEYS
// VERSIÓN ARREGLADA Y SIMPLIFICADA
// ============================================

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const pino = require('pino');

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Logger simple
const logger = pino({ level: 'info' });

// Supabase
let supabase;
try {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
  );
  logger.info('✅ Supabase conectado');
} catch (error) {
  logger.error('❌ Error conectando Supabase:', error.message);
}

// Almacenar sesiones activas
const activeSessions = new Map();
const qrCodes = new Map();
const wsClients = new Map();

// ============================================
// FUNCIONES AUXILIARES
// ============================================

async function initializeWhatsApp(userId) {
  try {
    logger.info(`🔄 Inicializando WhatsApp para usuario: ${userId}`);

    const sessionPath = path.join(__dirname, `sessions/${userId}`);
    
    // Crear carpeta si no existe
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
      logger.info(`📁 Carpeta de sesión creada: ${sessionPath}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Hoomi CRM', 'Safari', '1.0.0'],
      syncFullHistory: false,
    });

    // Evento: Actualización de conexión
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info(`📱 QR generado para ${userId}`);
        try {
          const qrImage = await QRCode.toDataURL(qr);
          qrCodes.set(userId, qrImage);
          logger.info(`✅ QR guardado en memoria para ${userId}`);
          
          // Notificar al frontend
          broadcastToUser(userId, {
            type: 'QR_GENERATED',
            qr: qrImage,
          });
        } catch (error) {
          logger.error(`❌ Error generando QR: ${error.message}`);
        }
      }

      if (connection === 'open') {
        logger.info(`✅ WhatsApp conectado para ${userId}`);
        qrCodes.delete(userId);
        
        // Guardar sesión en Supabase
        if (supabase) {
          try {
            await supabase.from('whatsapp_sessions').upsert({
              asesor_id: userId,
              status: 'connected',
              phone: sock.user?.id || 'unknown',
              last_activity: new Date(),
            });
            logger.info(`💾 Sesión guardada en Supabase para ${userId}`);
          } catch (error) {
            logger.error(`❌ Error guardando sesión en Supabase: ${error.message}`);
          }
        }

        broadcastToUser(userId, {
          type: 'SESSION_CONNECTED',
          phone: sock.user?.id,
        });
      }

      if (connection === 'close') {
        logger.warn(`⚠️ Conexión cerrada para ${userId}`);
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut;

        if (shouldReconnect) {
          logger.info(`🔄 Reconectando ${userId}...`);
          setTimeout(() => initializeWhatsApp(userId), 3000);
        } else {
          logger.info(`❌ Sesión cerrada para ${userId}`);
          activeSessions.delete(userId);
          
          if (supabase) {
            try {
              await supabase.from('whatsapp_sessions').update({
                status: 'disconnected',
              }).eq('asesor_id', userId);
            } catch (error) {
              logger.error(`❌ Error actualizando sesión: ${error.message}`);
            }
          }
        }
      }
    });

    // Evento: Credenciales actualizadas
    sock.ev.on('creds.update', saveCreds);

    // Evento: Mensaje recibido
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages[0];

        if (!message.key.fromMe && message.message) {
          const text =
            message.message.conversation ||
            message.message.extendedTextMessage?.text ||
            '';

          const phone = message.key.remoteJid.split('@')[0];

          logger.info(`📨 Mensaje recibido de ${phone}: ${text.substring(0, 50)}`);

          // Guardar en Supabase
          if (supabase) {
            try {
              await supabase.from('whatsapp_messages').insert({
                asesor_id: userId,
                phone,
                message: text,
                direction: 'incoming',
                timestamp: new Date(message.messageTimestamp * 1000),
                status: 'received',
              });
            } catch (error) {
              logger.error(`❌ Error guardando mensaje: ${error.message}`);
            }
          }

          // Notificar al frontend
          broadcastToUser(userId, {
            type: 'MESSAGE_RECEIVED',
            phone,
            message: text,
            timestamp: new Date(),
          });
        }
      } catch (error) {
        logger.error(`❌ Error procesando mensaje: ${error.message}`);
      }
    });

    activeSessions.set(userId, sock);
    logger.info(`✅ WhatsApp inicializado para ${userId}`);
    return sock;
  } catch (error) {
    logger.error(`❌ Error inicializando WhatsApp para ${userId}:`, error.message);
    throw error;
  }
}

function broadcastToUser(userId, data) {
  let count = 0;
  wsClients.forEach((client, id) => {
    if (id.startsWith(userId) && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
      count++;
    }
  });
  if (count > 0) {
    logger.info(`📡 Broadcast enviado a ${count} cliente(s) de ${userId}`);
  }
}

// ============================================
// RUTAS API
// ============================================

// Health Check
app.get('/api/health', (req, res) => {
  logger.info('🏥 Health check');
  res.json({
    status: 'ok',
    timestamp: new Date(),
    supabase: supabase ? 'connected' : 'disconnected',
  });
});

// Iniciar sesión WhatsApp
app.post('/api/whatsapp/init', async (req, res) => {
  try {
    const { userId } = req.body;

    logger.info(`📞 POST /api/whatsapp/init - userId: ${userId}`);

    if (!userId) {
      logger.warn('⚠️ userId no proporcionado');
      return res.status(400).json({ error: 'userId requerido' });
    }

    if (activeSessions.has(userId)) {
      logger.warn(`⚠️ Sesión ya activa para ${userId}`);
      return res.status(400).json({ error: 'Sesión ya activa' });
    }

    await initializeWhatsApp(userId);
    logger.info(`✅ Inicialización enviada para ${userId}`);
    res.json({ success: true, message: 'Inicializando WhatsApp...' });
  } catch (error) {
    logger.error(`❌ Error en /api/whatsapp/init: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Obtener QR
app.get('/api/whatsapp/qr/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    logger.info(`📱 GET /api/whatsapp/qr/:${userId}`);

    const qr = qrCodes.get(userId);

    if (!qr) {
      logger.warn(`⚠️ QR no disponible para ${userId}`);
      return res.status(404).json({ error: 'QR no disponible' });
    }

    logger.info(`✅ QR retornado para ${userId}`);
    res.json({ qr });
  } catch (error) {
    logger.error(`❌ Error en /api/whatsapp/qr: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Enviar mensaje
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { userId, phone, message } = req.body;

    logger.info(`💬 POST /api/whatsapp/send - userId: ${userId}, phone: ${phone}`);

    if (!userId || !phone || !message) {
      logger.warn('⚠️ Parámetros incompletos');
      return res.status(400).json({ error: 'Parámetros requeridos' });
    }

    const sock = activeSessions.get(userId);
    if (!sock) {
      logger.warn(`⚠️ Sesión no activa para ${userId}`);
      return res.status(400).json({ error: 'Sesión no activa' });
    }

    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });

    logger.info(`✅ Mensaje enviado a ${phone}`);

    // Guardar en Supabase
    if (supabase) {
      try {
        await supabase.from('whatsapp_messages').insert({
          asesor_id: userId,
          phone,
          message,
          direction: 'outgoing',
          timestamp: new Date(),
          status: 'sent',
        });
      } catch (error) {
        logger.error(`❌ Error guardando mensaje: ${error.message}`);
      }
    }

    res.json({ success: true });
  } catch (error) {
    logger.error(`❌ Error en /api/whatsapp/send: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Obtener mensajes
app.get('/api/whatsapp/messages/:userId/:phone', async (req, res) => {
  try {
    const { userId, phone } = req.params;

    logger.info(`📨 GET /api/whatsapp/messages - userId: ${userId}, phone: ${phone}`);

    if (!supabase) {
      return res.status(500).json({ error: 'Supabase no conectado' });
    }

    const { data: messages, error } = await supabase
      .from('whatsapp_messages')
      .select('*')
      .eq('asesor_id', userId)
      .eq('phone', phone)
      .order('timestamp', { ascending: true });

    if (error) {
      logger.error(`❌ Error obteniendo mensajes: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }

    logger.info(`✅ ${messages.length} mensajes retornados`);
    res.json({ messages });
  } catch (error) {
    logger.error(`❌ Error en /api/whatsapp/messages: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Obtener conversaciones
app.get('/api/whatsapp/conversations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    logger.info(`💬 GET /api/whatsapp/conversations - userId: ${userId}`);

    if (!supabase) {
      return res.status(500).json({ error: 'Supabase no conectado' });
    }

    const { data: messages, error } = await supabase
      .from('whatsapp_messages')
      .select('phone, message, timestamp, direction')
      .eq('asesor_id', userId)
      .order('timestamp', { ascending: false });

    if (error) {
      logger.error(`❌ Error obteniendo conversaciones: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }

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

    logger.info(`✅ ${Object.keys(conversations).length} conversaciones retornadas`);
    res.json({ conversations: Object.values(conversations) });
  } catch (error) {
    logger.error(`❌ Error en /api/whatsapp/conversations: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Estado de sesión
app.get('/api/whatsapp/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    logger.info(`📊 GET /api/whatsapp/status - userId: ${userId}`);

    if (!supabase) {
      return res.status(500).json({ error: 'Supabase no conectado' });
    }

    const { data: session, error } = await supabase
      .from('whatsapp_sessions')
      .select('*')
      .eq('asesor_id', userId)
      .single();

    const hasQR = qrCodes.has(userId);
    const isActive = activeSessions.has(userId);

    logger.info(`✅ Estado: hasQR=${hasQR}, isActive=${isActive}`);

    res.json({
      status: session?.status || 'disconnected',
      phone: session?.phone,
      hasQR,
      isActive,
    });
  } catch (error) {
    logger.error(`❌ Error en /api/whatsapp/status: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Desconectar
app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    const { userId } = req.body;

    logger.info(`🔌 POST /api/whatsapp/disconnect - userId: ${userId}`);

    const sock = activeSessions.get(userId);
    if (sock) {
      await sock.logout();
      activeSessions.delete(userId);
      logger.info(`✅ Sesión cerrada para ${userId}`);
    }

    qrCodes.delete(userId);

    if (supabase) {
      try {
        await supabase.from('whatsapp_sessions').update({
          status: 'disconnected',
        }).eq('asesor_id', userId);
      } catch (error) {
        logger.error(`❌ Error actualizando sesión: ${error.message}`);
      }
    }

    res.json({ success: true });
  } catch (error) {
    logger.error(`❌ Error en /api/whatsapp/disconnect: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WEBSOCKET
// ============================================

wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');
    
    if (userId) {
      const clientId = `${userId}-${Date.now()}`;
      wsClients.set(clientId, ws);
      logger.info(`✅ WebSocket conectado: ${clientId}`);

      ws.on('close', () => {
        wsClients.delete(clientId);
        logger.info(`❌ WebSocket desconectado: ${clientId}`);
      });

      ws.on('error', (error) => {
        logger.error(`❌ Error WebSocket: ${error.message}`);
      });
    }
  } catch (error) {
    logger.error(`❌ Error en WebSocket connection: ${error.message}`);
  }
});

// ============================================
// MANEJO DE ERRORES GLOBAL
// ============================================

app.use((err, req, res, next) => {
  logger.error(`❌ Error global: ${err.message}`);
  res.status(500).json({ error: err.message });
});

// ============================================
// INICIAR SERVIDOR
// ============================================

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  logger.info(`
╔════════════════════════════════════════╗
║   🚀 HOOMI CRM - WHATSAPP BACKEND      ║
║   Servidor escuchando en puerto ${PORT}      ║
║   Ambiente: ${process.env.NODE_ENV || 'development'}           ║
╚════════════════════════════════════════╝
  `);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('❌ Uncaught Exception:', error);
});
