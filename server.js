const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const STORAGE_DIR = path.join(__dirname, 'cloud_vault');
fs.ensureDirSync(STORAGE_DIR);

app.post('/api/fetch-to-cloud', async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Kailangan ng valid na link' });

    try {
        const transferId = crypto.randomBytes(8).toString('hex');
        const filename = `app_${transferId}.apk`;
        const filePath = path.join(STORAGE_DIR, filename);

        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
            }
        });

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        writer.on('finish', async () => {
            const stats = await fs.stat(filePath);
            
            // Proteksyon laban sa maling link o HTML warning pages (dapat mas mataas sa 5MB)
            if (stats.size < 1024 * 1024 * 5) { 
                await fs.remove(filePath);
                return res.status(400).json({ 
                    error: 'Hinarang ng site o HTML page lang ang nakuha. Siguraduhing DIRECT DOWNLOAD LINK ang i-paste mo.' 
                });
            }

            res.json({
                success: true,
                transferId: transferId,
                filename: filename,
                fileSize: stats.size,
                relayApi: `/api/relay/stream/${transferId}`
            });
        });

        writer.on('error', async () => {
            await fs.remove(filePath).catch(() => {});
            res.status(500).json({ error: 'Bigo ang pag-download sa cloud server.' });
        });

    } catch (err) {
        res.status(500).json({ error: 'Hindi ma-access ang ibinigay na URL.' });
    }
});

// Stream Relay + Instant Auto-Delete sa Server pagkatapos ibaba sa phone
app.get('/api/relay/stream/:transferId', (req, res) => {
    const { transferId } = req.params;
    const filename = `app_${transferId}.apk`;
    const filePath = path.join(STORAGE_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Wala na ang file o na-delete na.' });
    }

    const stat = fs.statSync(filePath);

    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${filename}"`
    });

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);

    const cleanup = () => {
        if (fs.existsSync(filePath)) {
            fs.remove(filePath)
                .then(() => console.log(`[INSTANT CLEANUP] Naipasa na at agad na binura sa server.`))
                .catch(() => {});
        }
    };

    res.on('finish', cleanup);
    readStream.on('close', cleanup);
    res.on('close', cleanup);
});

app.listen(PORT, () => {
    console.log(`Server active on port ${PORT}`);
});
                
