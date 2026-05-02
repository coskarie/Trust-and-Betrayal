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

    // ==========================================
    // 카지노 6종 게임 기초 통신 처리부
    // (현재는 작동 확인을 위해 랜덤 결과만 전송)
    // ==========================================
    socket.on('playGame', ({ roomNum, game, data }) => {
        const roomName = `room-${roomNum}`;
        let resultMessage = "";

        switch(game) {
            case 'gacha':
                // data 에는 유저가 누른 1~10 구슬 번호가 들어옴
                const resultMarble = Math.floor(Math.random() * 10) + 1;
                if (data === resultMarble) {
                    resultMessage = `[구슬뽑기] 정답입니다! 결과는 ${resultMarble}번 구슬이었습니다.`;
                } else {
                    resultMessage = `[구슬뽑기] 아쉽습니다. 결과는 ${resultMarble}번 구슬이었습니다.\n(선택: ${data})`;
                }
                break;
            case 'slot':
                const slots = [Math.floor(Math.random() * 7)+1, Math.floor(Math.random() * 7)+1, Math.floor(Math.random() * 7)+1];
                resultMessage = `[슬롯머신] 결과: [ ${slots[0]} | ${slots[1]} | ${slots[2]} ]`;
                if(slots[0] === slots[1] && slots[1] === slots[2]) resultMessage += "\nJACKPOT!!";
                break;
            case 'roulette':
                const rouletteResult = Math.floor(Math.random() * 37); // 0~36
                resultMessage = `[룰렛] 휠이 멈췄습니다. 결과는 [ ${rouletteResult} ]!`;
                break;
            case 'graph_start':
                resultMessage = `[그래프] 배당률 상승 시작... 타이밍을 맞춰 멈추세요!`;
                break;
            case 'graph_stop':
                resultMessage = `[그래프] 정지! 현재 배당률에서 수익을 확정했습니다.`;
                break;
            case 'blackjack_hit':
                resultMessage = `[블랙잭] 카드를 한 장 더 받습니다. (Hit)`;
                break;
            case 'blackjack_stand':
                resultMessage = `[블랙잭] 현재 패를 유지합니다. (Stand)`;
                break;
            case 'blackjack_touch':
                resultMessage = `[블랙잭] 카드를 터치하여 확인했습니다.`;
                break;
            case 'holdem_call':
                resultMessage = `[5장 홀덤] 콜 (Call) 하셨습니다.`;
                break;
            case 'holdem_raise':
                resultMessage = `[5장 홀덤] 판돈을 올립니다. (Raise)`;
                break;
            case 'holdem_fold':
                resultMessage = `[5장 홀덤] 이번 판을 포기합니다. (Fold)`;
                break;
            default:
                resultMessage = "알 수 없는 명령입니다.";
        }

        // 해당 클라이언트에게 결과 텍스트 전송
        socket.emit('gameResult', { msg: resultMessage });
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