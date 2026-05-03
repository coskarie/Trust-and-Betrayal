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
            case 'gacha_result':
                // 웹(Canvas)에서 계산되어 1등으로 들어온 구슬 번호(winner)를 받음
                if (data.target === data.winner) {
                    resultMessage = `[구슬뽑기] 정답입니다! ${data.winner}번 구슬이 1등으로 들어왔습니다!`;
                } else {
                    resultMessage = `[구슬뽑기] 아쉽습니다. 1등 구슬은 ${data.winner}번 이었습니다.\n(당신의 선택: ${data.target})`;
                }
                break;
            case 'slot':
                const slotSymbols = ['1','2','3','4','5','6','7','8','9','♠','♤','♣','♧','♦','♢','♥','♡'];
                const getRandomSymbol = () => slotSymbols[Math.floor(Math.random() * slotSymbols.length)];

                let s1 = getRandomSymbol();
                let s2 = getRandomSymbol();
                let s3 = getRandomSymbol();

                // 🔥 7 7 7 극악 난이도 방어 로직 🔥
                // 만약 기적적으로 앞의 두 개가 7, 7이 나왔다면?
                if (s1 === '7' && s2 === '7') {
                    // 3번째 릴에서 7이 나올 뻔 했어도, 95% 확률로 다른 문양(스페이드)으로 비틀어버림 (일명 억까 로직)
                    if (s3 === '7') {
                        if (Math.random() < 0.95) { 
                            s3 = '♠'; 
                        }
                    }
                }

                let msg = `[슬롯머신] 결과: [ ${s1} | ${s2} | ${s3} ]`;
                if (s1 === s2 && s2 === s3) {
                    msg += (s1 === '7') ? "\n🎉 JACKPOT! 777 당첨! 🎉" : "\n✨ 당첨입니다! ✨";
                } else {
                    msg += "\n꽝입니다.";
                }

                // 슬롯머신은 결과를 전용 이벤트로 보냅니다.
                socket.emit('slotResult', { result: [s1, s2, s3], msg: msg });
                return; // 기존 gameResult emit을 타지 않도록 return
            case 'roulette':
                // data 에는 유저가 베팅한 옵션이 들어옴 (예: 'Red', '0', '1st 12', '15' 등)
                const rouletteResultNum = Math.floor(Math.random() * 37); // 0~36 중 하나 추첨
                const redsArr = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
                
                const isR = redsArr.includes(rouletteResultNum);
                const isB = rouletteResultNum !== 0 && !isR;
                const isE = rouletteResultNum !== 0 && rouletteResultNum % 2 === 0;
                const isO = rouletteResultNum !== 0 && rouletteResultNum % 2 !== 0;
                
                let isWin = false;
                let bet = data;
                
                // 베팅 적중 판정 로직
                if (bet === 'Red' && isR) isWin = true;
                else if (bet === 'Black' && isB) isWin = true;
                else if (bet === 'Even' && isE) isWin = true;
                else if (bet === 'Odd' && isO) isWin = true;
                else if (bet === '1-18' && rouletteResultNum >= 1 && rouletteResultNum <= 18) isWin = true;
                else if (bet === '19-36' && rouletteResultNum >= 19 && rouletteResultNum <= 36) isWin = true;
                else if (bet === '1st 12' && rouletteResultNum >= 1 && rouletteResultNum <= 12) isWin = true;
                else if (bet === '2nd 12' && rouletteResultNum >= 13 && rouletteResultNum <= 24) isWin = true;
                else if (bet === '3rd 12' && rouletteResultNum >= 25 && rouletteResultNum <= 36) isWin = true;
                else if (bet === String(rouletteResultNum)) isWin = true; // 특정 숫자 맞춤

                let colorStr = rouletteResultNum === 0 ? '그린' : (isR ? '레드' : '블랙');
                let winMsg = isWin ? "🎉 당첨입니다! 배당금을 획득했습니다. 🎉" : "❌ 아쉽습니다. 베팅에 실패했습니다.";
                
                let finalMsg = `[룰렛] 휠이 멈췄습니다.\n결과: [ ${rouletteResultNum} ] (${colorStr})\n\n${winMsg}`;

                // 클라이언트에게 서버가 추첨한 번호를 전송 (Canvas에서 해당 칸에 멈추도록)
                socket.emit('rouletteResult', { resultNum: rouletteResultNum, msg: finalMsg });
                return;
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