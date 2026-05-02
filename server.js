const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 정적 파일(index.html 등) 제공
app.use(express.static(path.join(__dirname, '/')));

// 게임 방 상태를 관리하는 메모리 객체
const rooms = {};

io.on('connection', (socket) => {
    console.log(`[+] 새로운 유저 접속: ${socket.id}`);

    // 방 입장 처리
    socket.on('joinRoom', ({ name, roomNum }) => {
        const roomName = `room-${roomNum}`;
        
        // 방이 없으면 초기화
        if (!rooms[roomName]) {
            rooms[roomName] = {
                players: {},
                playerCount: 0,
                isGameStarted: false
            };
        }

        const room = rooms[roomName];

        // 인원 제한 (최대 2명)
        if (room.playerCount >= 2) {
            socket.emit('errorMsg', '방이 가득 찼습니다.');
            return;
        }

        // 이미 게임이 시작된 방인지 확인
        if (room.isGameStarted) {
            socket.emit('errorMsg', '이미 게임이 진행 중인 방입니다.');
            return;
        }

        // 역할 배정 (첫 번째: 데네브, 두 번째: 알비레오)
        const isPlayer1 = Object.values(room.players).length === 0;
        const role = isPlayer1 ? '데네브' : '알비레오';
        const playerSlot = isPlayer1 ? 'p1' : 'p2';

        // 플레이어 데이터 저장
        room.players[socket.id] = {
            id: socket.id,
            name: name,
            role: role,
            slot: playerSlot,
            isReady: false
        };
        room.playerCount++;

        // 소켓을 해당 방에 조인
        socket.join(roomName);

        // 방 접속 성공 응답 (본인에게)
        socket.emit('joinedRoom', {
            roomNum: roomNum,
            me: room.players[socket.id]
        });

        // 방 전체에 현재 상태 브로드캐스트
        io.to(roomName).emit('updateRoomState', Object.values(room.players));
        
        console.log(`[Room ${roomNum}] ${name}(${role}) 입장 (현재 인원: ${room.playerCount}/2)`);
    });

    // 준비 상태 토글 처리
    socket.on('toggleReady', ({ roomNum }) => {
        const roomName = `room-${roomNum}`;
        const room = rooms[roomName];

        if (room && room.players[socket.id]) {
            const player = room.players[socket.id];
            player.isReady = !player.isReady;
            
            io.to(roomName).emit('updateRoomState', Object.values(room.players));
        }
    });

    // 게임 시작 처리 (P1만 호출 가능)
    socket.on('startGame', ({ roomNum }) => {
        const roomName = `room-${roomNum}`;
        const room = rooms[roomName];

        if (room) {
            // 두 명 모두 준비되었는지 검증
            const players = Object.values(room.players);
            const allReady = players.length === 2 && players.every(p => p.isReady);

            if (allReady) {
                room.isGameStarted = true;
                io.to(roomName).emit('gameStarted');
                console.log(`[Room ${roomNum}] 게임이 시작되었습니다.`);
            } else {
                socket.emit('errorMsg', '모든 플레이어가 준비되지 않았습니다.');
            }
        }
    });

    // 접속 종료(새로고침, 탭 닫기 등) 처리
    socket.on('disconnect', () => {
        console.log(`[-] 유저 접속 종료: ${socket.id}`);
        
        // 모든 방을 순회하며 해당 유저 제거
        for (const roomName in rooms) {
            const room = rooms[roomName];
            if (room.players[socket.id]) {
                const playerName = room.players[socket.id].name;
                delete room.players[socket.id];
                room.playerCount--;

                // 남은 유저들에게 상태 업데이트
                io.to(roomName).emit('updateRoomState', Object.values(room.players));
                
                // 방에 아무도 없으면 방 폭파
                if (room.playerCount === 0) {
                    delete rooms[roomName];
                    console.log(`[${roomName}] 방이 폭파되었습니다.`);
                } else {
                    // 한 명이라도 나갔다면 게임 진행 상태 초기화 및 남은 인원 강제 준비 취소
                    room.isGameStarted = false;
                    for (const pid in room.players) {
                        room.players[pid].isReady = false;
                    }
                    io.to(roomName).emit('playerLeft', `${playerName} 님이 퇴장했습니다.`);
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[Server] http://localhost:${PORT} 에서 실행 중입니다.`);
});