// ============================================
// BACKEND NODE.JS - WHATSAPP WEB CON BAILEYS
// USANDO SUPABASE PARA ALMACENAR SESIONES
// ============================================

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
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

// Logger
const logger = pino({ level: 'info' });

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

logger.info('✅ Supabase inicializado');

// Almacenar sesiones activas
const activeSessions = new Map();
const wsClients = new Map();
const initializingUsers = new Set();

// ============================================
// CUSTOM AUTH STATE PROVIDER (SUPABASE)
// ============================================

async function createSupabaseAuthState(asesorId) {
  logger.info(`📦 Creando auth state para ${asesorId}`);

  // Obtener estado previo de Supabase
  const { data: existing } = await supabase
    .from('whatsapp_auth_state')
    .select('auth_state')
    .eq('asesor_id', asesorId)
    .single();

  const initialState = existing?.auth_state || {};

  return {
    creds: initialState.creds || null,
    keys: initialState.keys || {},

    // Guardar credenciales
    saveCreds: async () => {
      try {
        const state = {
          creds: this.creds,
          keys: this.keys,
        };

        await supabase
          .from('whatsapp_auth_state')
          .upsert({
            asesor_id: asesorId,
            auth_state: state,
            updated_at: new Date(),
          }, { onConflict: 'asesor_id' });

        logger.info(`💾 Credenciales guardadas para ${asesorId}`);
      } catch (error) {
        logger.error(`❌ Error guardando credenciales: ${error.message}`);
      }
    },

    // Cargar credenciales
    loadCreds: async () => {
      try {
        const { data } = await supabase
          .from('whatsapp_auth_state')
          .select('auth_state')
          .eq('asesor_id', asesorId)
          .single();

        if (data?.auth_state) {
          this.creds = data.auth_state.creds;
          this.keys = data.auth_state.keys;
          logger.info(`📂 Credenciales cargadas para ${asesorId}`);
        }
      } catch (error) {
        logger.error(`❌ Error cargando credenciales: ${error.message}`);
      }
    },
  };
}

// ============================================
// FUNCIONES AUXILIARES
// ============================================

async function initializeWhatsApp(userId) {
  try {
    if (initializingUsers.has(userId)) {
      logger.warn(`⚠️ Ya se está inicializando para ${userId}`);
      return;
    }

    initializingUsers.add(userId);
    logger.info(`🔄 Inicializando WhatsApp para usuario: ${userId}`);

    // Crear auth state con Supabase
    const authState = await createSupabaseAuthState(userId);
    await authState.loadCreds();

    const sock = makeWASocket({
      auth: authState,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Hoomi CRM', 'Safari', '1.0.0'],
      
      // OPTIMIZACIONES PARA SERVERLESS
      syncFullHistory: false,
      markOnlineOnConnect: true,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      
      // TIMEOUTS AUMENTADOS
      qrTimeout: 120000, // 2 minutos
      connectTimeoutMs: 120000,
      defaultQueryTimeoutMs: 0,
      
      // KEEP-ALIVE
      keepAliveIntervalMs: 30000,
      emitOwnEvents: true,
      
      // RETRIES
      retryRequestDelayMs: 250,
      maxRetries: 5,
    });

    let qrGenerated = false;

    // Evento: Actualización de conexión
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info(`📱 QR generado para ${userId}`);
        qrGenerated = true;
        try {
          const qrImage = await QRCode.toDataURL(qr);
          
          // Guardar QR en Supabase
          await supabase
            .from('whatsapp_auth_state')
            .update({
              qr_code: qrImage,
              status: 'waiting_for_scan',
              updated_at: new Date(),
            })
            .eq('asesor_id', userId);

          logger.info(`✅ QR guardado en Supabase para ${userId}`);
          
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
        initializingUsers.delete(userId);
        
        // Actualizar estado en Supabase
        try {
          await supabase
            .from('whatsapp_auth_state')
            .update({
              status: 'connected',
              phone: sock.user?.id || 'unknown',
              qr_code: null,
              updated_at: new Date(),
            })
            .eq('asesor_id', userId);

          // También guardar en whatsapp_sessions
          await supabase.from('whatsapp_sessions').upsert({
            asesor_id: userId,
            status: 'connected',
            phone: sock.user?.id || 'unknown',
            last_activity: new Date(),
          });

          logger.info(`💾 Sesión guardada para ${userId}`);
        } catch (error) {
          logger.error(`❌ Error guardando sesión: ${error.message}`);
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

        if (shouldReconnect && qrGenerated) {
          logger.info(`🔄 Reconectando ${userId}...`);
          initializingUsers.delete(userId);
          setTimeout(() => initializeWhatsApp(userId), 5000);
        } else if (!qrGenerated) {
          logger.warn(`⚠️ QR no se generó, reintentando...`);
          initializingUsers.delete(userId);
          setTimeout(() => initializeWhatsApp(userId), 5000);
        } else {
          logger.info(`❌ Sesión cerrada para ${userId}`);
          activeSessions.delete(userId);
          initializingUsers.delete(userId);
          
          try {
            await supabase
              .from('whatsapp_auth_state')
              .update({
                status: 'disconnected',
                qr_code: null,
                updated_at: new Date(),
              })
              .eq('asesor_id', userId);
          } catch (error) {
            logger.error(`❌ Error actualizando estado: ${error.message}`);
          }
        }
      }
    });

    // Evento: Credenciales actualizadas
    sock.ev.on('creds.update', async () => {
      try {
        await authState.saveCreds();
      } catch (error) {
        logger.error(`❌ Error guardando credenciales: ${error.message}`);
      }
    });

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

          logger.info(`📨 Mensaje recibido de ${phone}`);

          // Guardar en Supabase
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
  } catch (error) {
    logger.error(`❌ Error inicializando WhatsApp para ${userId}:`, error.message);
    initializingUsers.delete(userId);
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
    logger.info(`📡 Broadcast enviado a ${count} cliente(s)`);
  }
}

// ============================================
// RUTAS API
// ============================================

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
  });
});

// Iniciar sesión WhatsApp
app.post('/api/whatsapp/init', async (req, res) => {
  try {
    const { userId } = req.body;

    logger.info(`📞 POST /api/whatsapp/init - userId: ${userId}`);

    if (!userId) {
      return res.status(400).json({ error: 'userId requerido' });
    }

    if (activeSessions.has(userId)) {
      logger.warn(`⚠️ Sesión ya activa para ${userId}`);
      return res.status(400).json({ error: 'Sesión ya activa' });
    }

    // Iniciar en background
    initializeWhatsApp(userId).catch(error => {
      logger.error(`❌ Error en inicialización: ${error.message}`);
    });

    res.json({ 
      success: true, 
      message: 'Inicializando WhatsApp... Por favor espera hasta 2 minutos para que aparezca el QR.' 
    });
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

    // Obtener QR de Supabase
    const { data, error } = await supabase
      .from('whatsapp_auth_state')
      .select('qr_code, status')
      .eq('asesor_id', userId)
      .single();

    if (error || !data) {
      logger.warn(`⚠️ QR no disponible para ${userId}`);
      return res.status(404).json({ 
        error: 'QR no disponible',
        initializing: initializingUsers.has(userId)
      });
    }

    if (!data.qr_code) {
      logger.warn(`⚠️ QR aún no generado para ${userId}`);
      return res.status(404).json({ 
        error: 'QR aún no generado',
        status: data.status,
        initializing: initializingUsers.has(userId)
      });
    }

    logger.info(`✅ QR retornado para ${userId}`);
    res.json({ qr: data.qr_code });
  } catch (error) {
    logger.error(`❌ Error en /api/whatsapp/qr: ${error.message}`);
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

    logger.info(`✅ Mensaje enviado a ${phone}`);

    // Guardar en Supabase
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

    const { data: messages, error } = await supabase
      .from('whatsapp_messages')
      .select('*')
      .eq('asesor_id', userId)
      .eq('phone', phone)
      .order('timestamp', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

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

    const { data: messages, error } = await supabase
      .from('whatsapp_messages')
      .select('phone, message, timestamp, direction')
      .eq('asesor_id', userId)
      .order('timestamp', { ascending: false });

    if (error) {
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

    const { data: session, error } = await supabase
      .from('whatsapp_auth_state')
      .select('status, phone, qr_code')
      .eq('asesor_id', userId)
      .single();

    const isActive = activeSessions.has(userId);
    const isInitializing = initializingUsers.has(userId);

    res.json({
      status: session?.status || 'disconnected',
      phone: session?.phone,
      hasQR: !!session?.qr_code,
      isActive,
      isInitializing,
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

    const sock = activeSessions.get(userId);
    if (sock) {
      await sock.logout();
      activeSessions.delete(userId);
    }

    initializingUsers.delete(userId);

    try {
      await supabase
        .from('whatsapp_auth_state')
        .update({
          status: 'disconnected',
          qr_code: null,
          updated_at: new Date(),
        })
        .eq('asesor_id', userId);
    } catch (error) {
      logger.error(`❌ Error actualizando estado: ${error.message}`);
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
║   ✅ Usando Supabase para sesiones     ║
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
