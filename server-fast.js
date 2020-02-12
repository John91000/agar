const WebSocket = require('ws')
const {murmur2} = require('murmurhash-js')

const buffers = require('./buffers')
const Reader = require('./reader')
const algorithm = require('./algorithm')
const Entity = require('./entity')

let userWS = null

let stoppingBots = false

const userBots = []

const game = {
    url: '',
    protocolVersion: 0,
    clientVersion: 0
}

const user = {
    startedBots: false,
    isAlive: false,
    mouseX: 0,
    mouseY: 0
}

const bots = {
    name: '',
    amount: 0,
    ai: false
}

const dataBot = {
    ws: null,
    buffersKey: 0,
    isConnected: false,
    playersAmount: 0,
    lastPlayersAmount: 0,
    connect(){
        this.ws = new WebSocket(game.url, {
            origin: 'https://agar.io'
        })
        this.ws.onopen = this.onopen.bind(this)
        this.ws.onmessage = this.onmessage.bind(this)
        this.ws.onclose = this.onclose.bind(this)
    },
    send(buffer){
        if(this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(buffer)
    },
    onopen(){
        this.send(buffers.protocolVersion(game.protocolVersion))
        this.send(buffers.clientVersion(game.clientVersion))
        this.isConnected = true
    },
    onmessage(message){
        if(this.buffersKey) message.data = algorithm.rotateBufferBytes(message.data, this.buffersKey)
        this.handleBuffer(message.data)
    },
    onclose(){
        if(this.isConnected){
            this.isConnected = false
            console.log('[SERVER] DataBot disconnected')
        }
    },
    handleBuffer(buffer){
        const reader = new Reader(buffer)
        switch(reader.readUint8()){
            case 54:
                this.playersAmount = 0
                reader.byteOffset += 2
                while(reader.byteOffset < reader.buffer.byteLength){
                    const flags = reader.readUint8()
                    if(flags & 2) reader.readString()
                    if(flags & 4) reader.byteOffset += 4
                    this.playersAmount++
                }
                this.lastPlayersAmount = this.playersAmount
                break
            case 241:
                this.buffersKey = reader.readInt32() ^ game.clientVersion
                console.log('[SERVER] DataBot connected')
                break
        }
    }
}

function calculateDistance(botX, botY, targetX, targetY){
    return Math.hypot(targetX - botX, targetY - botY)
}

class Bot {
    constructor(){
        this.ws = null
        this.encryptionKey = 0
        this.decryptionKey = 0
        this.isConnected = false
        this.cellsIDs = []
        this.isAlive = false
        this.followMouseTimeout = null
        this.followMouse = false
        this.gotCaptcha = false
        this.viewportEntities = {}
        this.offsetX = 0
        this.offsetY = 0
        this.connect()
    }
    reset(){
        this.encryptionKey = 0
        this.decryptionKey = 0
        this.isConnected = false
        this.cellsIDs = []
        this.isAlive = false
        this.followMouseTimeout = null
        this.followMouse = false
        this.viewportEntities = {}
        this.offsetX = 0
        this.offsetY = 0
    }
    connect(){
        this.reset()
        this.ws = new WebSocket(game.url, {
            origin: 'https://agar.io'
        })
        this.ws.onopen = this.onopen.bind(this)
        this.ws.onmessage = this.onmessage.bind(this)
        this.ws.onerror = this.onerror.bind(this)
        this.ws.onclose = this.onclose.bind(this)
    }
    send(buffer){
        if(this.ws && this.ws.readyState === WebSocket.OPEN){
            if(this.encryptionKey){
                buffer = algorithm.rotateBufferBytes(buffer, this.encryptionKey)
                this.encryptionKey = algorithm.rotateEncryptionKey(this.encryptionKey)
            }
            this.ws.send(buffer)
        }
    }
    onopen(){
        this.send(buffers.protocolVersion(game.protocolVersion))
        this.send(buffers.clientVersion(game.clientVersion))
        this.isConnected = true
    }
    onmessage(message){
        if(this.decryptionKey) message.data = algorithm.rotateBufferBytes(message.data, this.decryptionKey ^ game.clientVersion)
        this.handleBuffer(message.data)
    }
    onerror(){
        setTimeout(() => {
            if(this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) this.ws.close()
        }, 1000)
    }
    onclose(){
        if(this.isConnected){
            this.isConnected = false
            if(!this.gotCaptcha) this.connect()
        }
    }
    handleBuffer(buffer){
        const reader = new Reader(buffer)
        switch(reader.readUint8()){
            case 32:
                this.cellsIDs.push(reader.readUint32())
                if(!this.isAlive){
                    this.isAlive = true
                    if(!user.startedBots){
                        setInterval(() => {
                            for(const bot of userBots){
                                if(bot.isAlive) bot.move()
                            }
                        }, 40)
                        userWS.send(Buffer.from([0]))
                        user.startedBots = true
                        console.log('[SERVER] Bots started')
                    }
                    if(!this.followMouseTimeout){
                        this.followMouseTimeout = setTimeout(() => {
                            if(this.isAlive) this.followMouse = true
                        }, 18000)
                    }
                }
                break
            case 85:
                if(!user.startedBots){
                    userWS.send(Buffer.from([3]))
                    setTimeout(process.exit, 1000)
                }
                this.gotCaptcha = true
                this.ws.close()
                break
            case 241:
                this.decryptionKey = reader.readInt32()
                this.encryptionKey = murmur2(`${game.url.match(/(live-arena-\w+\.agar\.io)/)[1]}${reader.readString()}`, 255)
                break
            case 242:
                this.send(buffers.spawn(bots.name))
                break
            case 255:
                this.handleCompressedBuffer(algorithm.uncompressBuffer(reader.buffer.slice(5), Buffer.allocUnsafe(reader.readUint32())))
                break
        }
    }
    handleCompressedBuffer(buffer){
        const reader = new Reader(buffer)
        switch(reader.readUint8()){
            case 16:
                this.updateViewportEntities(reader)
                break
            case 64:
                this.updateOffset(reader)
                break
        }
    }
    updateViewportEntities(reader){
        const eatRecordLength = reader.readUint16()
        for(let i = 0; i < eatRecordLength; i++) reader.byteOffset += 8
        while(true){
            const id = reader.readUint32()
            if(id === 0) break
            const entity = new Entity()
            entity.id = id
            entity.x = reader.readInt32()
            entity.y = reader.readInt32()
            entity.size = reader.readUint16()
            const flags = reader.readUint8()
            const extendedFlags = flags & 128 ? reader.readUint8() : 0
            if(flags & 1) entity.isVirus = true
            if(flags & 2) reader.byteOffset += 3
            if(flags & 4) reader.readString()
            if(flags & 8) entity.name = decodeURIComponent(escape(reader.readString()))
            if(extendedFlags & 1) entity.isPellet = true
            if(extendedFlags & 4) reader.byteOffset += 4
            if(this.viewportEntities[entity.id] && this.viewportEntities[entity.id].name && entity.name) entity.name = this.viewportEntities[entity.id].name
            this.viewportEntities[entity.id] = entity
        }
        const removeRecordLength = reader.readUint16()
        for(let i = 0; i < removeRecordLength; i++){
            const removedEntityID = reader.readUint32()
            if(this.cellsIDs.includes(removedEntityID)) this.cellsIDs.splice(this.cellsIDs.indexOf(removedEntityID), 1)
            delete this.viewportEntities[removedEntityID]
        }
        if(this.isAlive && this.cellsIDs.length === 0){
            this.isAlive = false
            if(this.followMouseTimeout){
                clearTimeout(this.followMouseTimeout)
                this.followMouseTimeout = null
            }
            this.followMouse = false
            this.send(buffers.spawn(bots.name))
        }
    }
    updateOffset(reader){
        const left = reader.readDouble()
        const top = reader.readDouble()
        const right = reader.readDouble()
        const bottom = reader.readDouble()
        if(~~(right - left) === 14142 && ~~(bottom - top) === 14142){
            this.offsetX = (left + right) / 2
            this.offsetY = (top + bottom) / 2
        }
    }
    getClosestEntity(type, botX, botY, botSize){
        let closestDistance = Infinity
        let closestEntity = null
        for(const entity of Object.values(this.viewportEntities)){
            let isConditionMet = false
            switch(type){
                case 'biggerPlayer':
                    isConditionMet = !entity.isVirus && !entity.isPellet && entity.size > botSize * 1.15 && entity.name !== bots.name
                    break
                case 'pellet':
                    isConditionMet = !entity.isVirus && entity.isPellet
                    break
            }
            if(isConditionMet){
                const distance = calculateDistance(botX, botY, entity.x, entity.y)
                if(distance < closestDistance){
                    closestDistance = distance
                    closestEntity = entity
                }
            }
        }
        return {
            distance: closestDistance,
            entity: closestEntity
        }
    }
    move(){
        const bot = {
            x: 0,
            y: 0,
            size: 0
        }
        for(const id of this.cellsIDs){
            const cell = this.viewportEntities[id]
            if(cell){
                bot.x += cell.x / this.cellsIDs.length
                bot.y += cell.y / this.cellsIDs.length
                bot.size += cell.size
            }
        }
        const closestBiggerPlayer = this.getClosestEntity('biggerPlayer', bot.x, bot.y, bot.size)
        const closestPellet = this.getClosestEntity('pellet', bot.x, bot.y, bot.size)
        if(user.isAlive){
            if(this.followMouse && !stoppingBots && !bots.ai) this.send(buffers.move(user.mouseX + this.offsetX, user.mouseY + this.offsetY, this.decryptionKey))
            else {
                if(closestBiggerPlayer.entity && closestBiggerPlayer.distance < 420){
                    const angle = (Math.atan2(closestBiggerPlayer.entity.y - bot.y, closestBiggerPlayer.entity.x - bot.x) + Math.PI) % (2 * Math.PI)
                    this.send(buffers.move(14142 * Math.cos(angle), 14142 * Math.sin(angle), this.decryptionKey))
                }
                else if(closestPellet.entity) this.send(buffers.move(closestPellet.entity.x, closestPellet.entity.y, this.decryptionKey))
                else if(!closestBiggerPlayer.entity && !closestPellet.entity){
                    const random = Math.random()
                    const randomX = ~~(1337 * Math.random())
                    const randomY = ~~(1337 * Math.random())
                    if(random > 0.5) this.send(buffers.move(bot.x + randomX, bot.y - randomY, this.decryptionKey))
                    else if(random < 0.5) this.send(buffers.move(bot.x - randomX, bot.y + randomY, this.decryptionKey))
                }
            }
        }
        else {
            if(closestBiggerPlayer.entity && closestBiggerPlayer.distance < 420){
                const angle = (Math.atan2(closestBiggerPlayer.entity.y - bot.y, closestBiggerPlayer.entity.x - bot.x) + Math.PI) % (2 * Math.PI)
                this.send(buffers.move(14142 * Math.cos(angle), 14142 * Math.sin(angle), this.decryptionKey))
            }
            else if(closestPellet.entity) this.send(buffers.move(closestPellet.entity.x, closestPellet.entity.y, this.decryptionKey))
            else if(!closestBiggerPlayer.entity && !closestPellet.entity){
                const random = Math.random()
                const randomX = ~~(1337 * Math.random())
                const randomY = ~~(1337 * Math.random())
                if(random > 0.5) this.send(buffers.move(bot.x + randomX, bot.y - randomY, this.decryptionKey))
                else if(random < 0.5) this.send(buffers.move(bot.x - randomX, bot.y + randomY, this.decryptionKey))
            }
        }
    }
}

console.log('[SERVER] Server has started. Awaiting user connection...');

new WebSocket.Server({
    port: 1337
}).on('connection', ws => {
    userWS = ws
    console.log('[SERVER] User connected')
    ws.on('message', buffer => {
        const reader = new Reader(buffer)
        switch(reader.readUint8()){
            case 0:
                if(!user.startedBots){
                    game.url = reader.readString()
                    game.protocolVersion = reader.readUint32()
                    game.clientVersion = reader.readUint32()
                    user.isAlive = !!reader.readUint8()
                    bots.name = reader.readString()
                    bots.amount = reader.readUint8()
                    dataBot.connect()
                    let index = 0
                    let startBotsInterval = setInterval(() => {
                        if(dataBot.lastPlayersAmount < 199 && index < bots.amount){
                            userBots.push(new Bot())
                            index++
                        }
                        else clearInterval(startBotsInterval)
                    }, 50)
                    console.log('[SERVER] Starting bots...')
                }
                break
            case 1:
                if(user.startedBots && !stoppingBots){
                    stoppingBots = true
                    ws.send(Buffer.from([1]))
                    let seconds = 0
                    setInterval(() => {
                        if(seconds === 30){
                            ws.send(Buffer.from([2]))
                            setTimeout(process.exit, 1000)
                        }
                        else {
                            console.log(`[SERVER] Stopping bots in ${30 - seconds} seconds`)
                            seconds++
                        }
                    }, 1000)
                }
                break
            case 2:
                for(const bot of userBots){
                    if(bot.isAlive && bot.followMouse && !stoppingBots && !bots.ai) bot.send(Buffer.from([17]))
                }
                break
            case 3:
                for(const bot of userBots){
                    if(bot.isAlive && bot.followMouse && !stoppingBots && !bots.ai) bot.send(Buffer.from([21]))
                }
                break
            case 4:
                bots.ai = !!reader.readUint8()
                break
            case 5:
                user.isAlive = !!reader.readUint8()
                break
            case 6:
                user.mouseX = reader.readInt32()
                user.mouseY = reader.readInt32()
                break
        }
    })
    ws.on('close', () => {
        if(user.startedBots && !stoppingBots){
            stoppingBots = true
            let seconds = 0
            setInterval(() => {
                if(seconds === 30) process.exit()
                else {
                    console.log(`[SERVER] Stopping bots in ${30 - seconds} seconds`)
                    seconds++
                }
            }, 1000)
        }
        console.log('[SERVER] User disconnected')
    })
})