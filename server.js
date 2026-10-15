const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const salas = {};
const desconexionesPendientes = {};
const temporizadoresBasta = {};
const temporizadoresRonda = {};
const ABECEDARIO = 'ABCDEFGHIKLMNOPQRSTUVXYZ'.split('');

function generarCodigo() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function limpiarTemporizadores(codigo) {
    if (temporizadoresRonda[codigo]) {
        clearInterval(temporizadoresRonda[codigo]);
        delete temporizadoresRonda[codigo];
    }
    if (temporizadoresBasta[codigo]) {
        clearInterval(temporizadoresBasta[codigo]);
        delete temporizadoresBasta[codigo];
    }
}

// Función limpia y directa: Lo que estaba en el snapshot es verde, lo nuevo o vacío es rojo
function aplicarAnulacionPorTrampa(sala) {
    if (!sala || !sala.jugadores) return;
    if (!sala.palabrasInvalidas) sala.palabrasInvalidas = {};

    sala.jugadores.forEach(j => {
        if ((j.strikes || 0) > 0) {
            const nombreClean = j.nombre.trim().toLowerCase();
            const snapshotPre = j.respuestasValidasPreTrampa || {};

            sala.categorias.forEach(cat => {
                const respActual = (j.respuestas && j.respuestas[cat]) ? String(j.respuestas[cat]).trim() : '';
                const respPrevia = (snapshotPre[cat]) ? String(snapshotPre[cat]).trim() : '';

                const keyNombre = `${nombreClean}-${cat}`;
                const keyId = `${j.id}-${cat}`;

                // REGLA DEFINITIVA:
                // Si la respuesta actual es exactamente igual a lo que había en el snapshot previo (y no está vacío), es VÁLIDA (Verde).
                // Si estaba vacío en el snapshot, o cambió/se agregó algo nuevo después, es INVÁLIDA (Rojo).
                if (respActual !== '' && respPrevia !== '' && respActual.toLowerCase() === respPrevia.toLowerCase()) {
                    delete sala.palabrasInvalidas[keyNombre];
                    delete sala.palabrasInvalidas[keyId];
                } else {
                    sala.palabrasInvalidas[keyNombre] = true;
                    sala.palabrasInvalidas[keyId] = true;
                }
            });
        }
    });
}

io.on('connection', (socket) => {
    console.log(`Jugador conectado: ${socket.id}`);

    // 1. CREAR SALA
    socket.on('crear_sala', ({ nombre, categorias, duracionRonda }) => {
        const codigo = generarCodigo();
        salas[codigo] = {
            codigo,
            anfitrion: socket.id,
            categorias,
            duracionRonda: parseInt(duracionRonda) || 60,
            estado: 'lobby',
            letraActual: '',
            letrasUsadas: [],
            palabrasInvalidas: {},
            confirmadosRevision: [],
            jugadores: [
                { id: socket.id, nombre, puntos: 0, respuestas: {}, strikes: 0 }
            ]
        };

        socket.join(codigo);
        socket.emit('sala_creada', { codigo, sala: salas[codigo] });
    });

    // 2. UNIRSE A SALA
    socket.on('unirse_sala', ({ codigo, nombre }) => {
        const sala = salas[codigo ? codigo.toUpperCase() : ''];
        if (!sala) {
            socket.emit('error_sala', 'La sala no existe.');
            return;
        }
        if (sala.estado !== 'lobby') {
            socket.emit('error_sala', 'La partida ya comenzó.');
            return;
        }

        const nuevoJugador = { id: socket.id, nombre, puntos: 0, respuestas: {}, strikes: 0 };
        sala.jugadores.push(nuevoJugador);

        socket.join(codigo.toUpperCase());
        io.to(codigo.toUpperCase()).emit('actualizar_sala', sala);
    });

    // 3. INICIAR RONDA
    socket.on('iniciar_ronda', ({ codigo }) => {
        const sala = salas[codigo];
        if (!sala) return;

        limpiarTemporizadores(codigo);

        const disponibles = ABECEDARIO.filter(l => !sala.letrasUsadas.includes(l));
        const nuevaLetra = disponibles[Math.floor(Math.random() * disponibles.length)] || 'A';

        sala.letraActual = nuevaLetra;
        sala.letrasUsadas.push(nuevaLetra);
        sala.estado = 'jugando';
        sala.palabrasInvalidas = {};
        sala.confirmadosRevision = [];

        sala.jugadores.forEach(j => {
            j.respuestas = {};
            j.strikes = 0;
        });

        let tiempoRestante = sala.duracionRonda;

        io.to(codigo).emit('ronda_iniciada', {
            letraActual: nuevaLetra,
            duracionRonda: tiempoRestante,
            sala
        });

        temporizadoresRonda[codigo] = setInterval(() => {
            tiempoRestante -= 1;

            if (tiempoRestante >= 0) {
                io.to(codigo).emit('tiempo_ronda_tick', { tiempoRestante });
            }

            if (tiempoRestante <= 0) {
                limpiarTemporizadores(codigo);

                aplicarAnulacionPorTrampa(sala);

                sala.estado = 'revision';
                sala.confirmadosRevision = [];

                io.to(codigo).emit('ir_a_revision', { sala });
                io.to(codigo).emit('revision_actualizada', {
                    palabrasInvalidas: { ...sala.palabrasInvalidas },
                    confirmadosRevision: sala.confirmadosRevision
                });
            }
        }, 1000);
    });

    // 4. GRITAR ¡BASTA!
    socket.on('gritar_basta', ({ codigo, respuestas }) => {
        const sala = salas[codigo ? codigo.toUpperCase() : ''];
        if (!sala || sala.estado !== 'jugando') return;

        const todasCompletadas = sala.categorias.every(
            cat => respuestas && respuestas[cat] && respuestas[cat].trim().length > 0
        );

        if (!todasCompletadas) {
            socket.emit('error_sala', 'Debes completar todas las categorías antes de gritar BASTA.');
            return;
        }

        const jugador = sala.jugadores.find(j => j.id === socket.id);
        if (jugador) jugador.respuestas = respuestas;

        if (temporizadoresRonda[codigo]) {
            clearInterval(temporizadoresRonda[codigo]);
            delete temporizadoresRonda[codigo];
        }

        if (temporizadoresBasta[codigo]) return;

        let tiempoBasta = 10;

        io.to(sala.codigo).emit('basta_gritado', {
            iniciador: jugador ? jugador.nombre : 'Alguien',
            conteoBasta: tiempoBasta,
            sala
        });

        temporizadoresBasta[codigo] = setInterval(() => {
            tiempoBasta -= 1;

            if (tiempoBasta > 0) {
                io.to(sala.codigo).emit('conteo_basta_tick', { tiempoRestante: tiempoBasta });
            } else {
                limpiarTemporizadores(codigo);

                aplicarAnulacionPorTrampa(sala);

                sala.estado = 'revision';
                sala.confirmadosRevision = [];

                io.to(sala.codigo).emit('ir_a_revision', { sala });
                io.to(sala.codigo).emit('revision_actualizada', {
                    palabrasInvalidas: { ...sala.palabrasInvalidas },
                    confirmadosRevision: sala.confirmadosRevision
                });
            }
        }, 1000);
    });

    // Evento 5: REGISTRAR TRAMPA INMEDIATA (Solo congela la primera vez que detecta trampa)
    socket.on('registrar_trampa', ({ codigo, respuestas }) => {
        const salaCodigoClean = codigo ? codigo.toUpperCase() : '';
        const sala = salas[salaCodigoClean];
        if (!sala || sala.estado !== 'jugando') return;

        const jugador = sala.jugadores.find(j => j.id === socket.id);
        if (jugador) {
            // Solo sumamos strike y congelamos el snapshot la PRIMERA VEZ que hace trampa
            if (!jugador.strikes || jugador.strikes === 0) {
                jugador.strikes = 1;
                // Guardamos la foto exacta de lo que tenía escrito en este preciso instante
                jugador.respuestasValidasPreTrampa = { ...(respuestas || {}) };
            }

            jugador.respuestas = respuestas || {};
            aplicarAnulacionPorTrampa(sala);
        }

        io.to(sala.codigo).emit('actualizar_sala', sala);
        io.to(sala.codigo).emit('revision_actualizada', {
            palabrasInvalidas: { ...sala.palabrasInvalidas },
            confirmadosRevision: [...(sala.confirmadosRevision || [])]
        });
    });

    // 6. GUARDAR RESPUESTAS FINALES con Depuración
    socket.on('guardar_respuestas_finales', ({ codigo, respuestas }) => {
        const sala = salas[codigo ? codigo.toUpperCase() : ''];
        if (!sala) return;

        console.log(`💾 Guardando respuestas finales para socket ${socket.id}:`, respuestas);

        const jugador = sala.jugadores.find(j => j.id === socket.id);
        if (jugador) {
            jugador.respuestas = respuestas || {};
            aplicarAnulacionPorTrampa(sala);
        }

        io.to(sala.codigo).emit('actualizar_sala', sala);
        io.to(sala.codigo).emit('revision_actualizada', {
            palabrasInvalidas: { ...sala.palabrasInvalidas },
            confirmadosRevision: [...(sala.confirmadosRevision || [])]
        });
    });

    // 7. CAMBIAR ESTADO DE PALABRA
    socket.on('toggle_palabra_invalida', ({ codigo, jugadorId, categoria }) => {
        const sala = salas[codigo ? codigo.toUpperCase() : ''];
        if (!sala || sala.estado !== 'revision') return;

        const jugadorObjetivo = sala.jugadores.find(j => j.id === jugadorId);
        if (!jugadorObjetivo) return;

        if (socket.id === jugadorId) return;

        if (!sala.palabrasInvalidas) sala.palabrasInvalidas = {};

        const key = `${jugadorObjetivo.nombre.trim().toLowerCase()}-${categoria}`;

        if (sala.palabrasInvalidas[key]) {
            delete sala.palabrasInvalidas[key];
        } else {
            sala.palabrasInvalidas[key] = true;
        }

        sala.confirmadosRevision = [];

        io.to(sala.codigo).emit('revision_actualizada', {
            palabrasInvalidas: { ...sala.palabrasInvalidas },
            confirmadosRevision: [...sala.confirmadosRevision]
        });
    });

    // 8. CONFIRMAR REVISIÓN
    socket.on('confirmar_revision', ({ codigo }) => {
        const sala = salas[codigo];
        if (!sala || sala.estado !== 'revision') return;

        if (!sala.confirmadosRevision) sala.confirmadosRevision = [];

        if (!sala.confirmadosRevision.includes(socket.id)) {
            sala.confirmadosRevision.push(socket.id);
        }

        io.to(codigo).emit('revision_actualizada', {
            palabrasInvalidas: { ...(sala.palabrasInvalidas || {}) },
            confirmadosRevision: [...sala.confirmadosRevision]
        });

        if (sala.confirmadosRevision.length >= sala.jugadores.length) {
            sala.jugadores.forEach(j => {
                let puntosRonda = 0;

                Object.keys(j.respuestas || {}).forEach(cat => {
                    const nombreClean = j.nombre.trim().toLowerCase();
                    const key = `${nombreClean}-${cat}`;
                    const keyId = `${j.id}-${cat}`;

                    // Si tiene strikes o está en palabrasInvalidas, se anula
                    const estaAnulada = Boolean(
                        (j.strikes || 0) > 0 ||
                        (sala.palabrasInvalidas && (sala.palabrasInvalidas[key] || sala.palabrasInvalidas[keyId]))
                    );

                    if (estaAnulada) return;

                    const resp = (j.respuestas[cat] || '').trim().toLowerCase();
                    if (!resp) return;

                    const duplicados = sala.jugadores.filter(otro => {
                        const otroNombreClean = otro.nombre.trim().toLowerCase();
                        const otroKey = `${otroNombreClean}-${cat}`;
                        const otroKeyId = `${otro.id}-${cat}`;
                        const otroAnulado = Boolean(
                            (otro.strikes || 0) > 0 ||
                            (sala.palabrasInvalidas && (sala.palabrasInvalidas[otroKey] || sala.palabrasInvalidas[otroKeyId]))
                        );
                        if (otroAnulado) return false;
                        return (otro.respuestas[cat] || '').trim().toLowerCase() === resp;
                    }).length;

                    puntosRonda += duplicados > 1 ? 50 : 100;
                });

                puntosRonda = Math.max(0, puntosRonda - ((j.strikes || 0) * 100));
                j.puntos = (j.puntos || 0) + puntosRonda;
            });

            sala.estado = 'podio';
            io.to(codigo).emit('resultados_calculados', sala);
        }
    });

    // 9. RECONEXIÓN
    socket.on('reconectar_jugador', ({ codigo, nombre }) => {
        const sala = salas[codigo ? codigo.toUpperCase() : ''];
        if (!sala) {
            socket.emit('error_reconexion', 'La sala ya no existe.');
            return;
        }

        if (nombre && desconexionesPendientes[nombre]) {
            clearTimeout(desconexionesPendientes[nombre]);
            delete desconexionesPendientes[nombre];
        }

        let jugador = sala.jugadores.find(j => j.nombre.toLowerCase() === (nombre || '').toLowerCase());

        if (jugador) {
            const viejoId = jugador.id;
            jugador.id = socket.id;

            if (sala.anfitrion === viejoId) sala.anfitrion = socket.id;

            if (sala.confirmadosRevision) {
                const index = sala.confirmadosRevision.indexOf(viejoId);
                if (index !== -1) sala.confirmadosRevision[index] = socket.id;
            }

            socket.join(sala.codigo);
            socket.emit('reconexion_exitosa', { codigo: sala.codigo, sala });
            io.to(sala.codigo).emit('actualizar_sala', sala);
        } else {
            socket.emit('error_reconexion', 'No se encontró tu sesión previa.');
        }
    });

    // 10. SALIDA VOLUNTARIA
    socket.on('salir_sala', ({ codigo }) => {
        const sala = salas[codigo ? codigo.toUpperCase() : ''];
        if (sala) {
            sala.jugadores = sala.jugadores.filter(j => j.id !== socket.id);

            if (sala.confirmadosRevision) {
                sala.confirmadosRevision = sala.confirmadosRevision.filter(id => id !== socket.id);
            }

            if (sala.jugadores.length === 0) {
                limpiarTemporizadores(codigo.toUpperCase());
                delete salas[codigo.toUpperCase()];
            } else {
                io.to(sala.codigo).emit('actualizar_sala', sala);
            }
            socket.leave(sala.codigo);
        }
    });

    // 11. DESCONEXIÓN CON TOLERANCIA
    socket.on('disconnect', () => {
        Object.keys(salas).forEach(codigo => {
            const sala = salas[codigo];
            const jugador = sala.jugadores.find(j => j.id === socket.id);

            if (jugador) {
                const nombreJugador = jugador.nombre;

                if (desconexionesPendientes[nombreJugador]) {
                    clearTimeout(desconexionesPendientes[nombreJugador]);
                }

                desconexionesPendientes[nombreJugador] = setTimeout(() => {
                    const sigueEnSala = sala.jugadores.find(j => j.nombre === nombreJugador);
                    if (sigueEnSala && !io.sockets.sockets.has(sigueEnSala.id)) {
                        sala.jugadores = sala.jugadores.filter(j => j.nombre !== nombreJugador);

                        if (sala.jugadores.length === 0) {
                            limpiarTemporizadores(codigo);
                            delete salas[codigo];
                        } else {
                            io.to(codigo).emit('actualizar_sala', sala);
                        }
                    }
                    delete desconexionesPendientes[nombreJugador];
                }, 15000);
            }
        });
    });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo correctamente en el puerto ${PORT}`);
});