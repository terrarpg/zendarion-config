const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const app = express();
const port = process.env.PORT || 3000;

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    next();
});

// Middleware pour logger les requêtes
app.use((req, res, next) => {
    console.log(`📨 ${req.method} ${req.path}`);
    next();
});

// Route principale - Liste des fichiers
app.get('/files/', (req, res) => {
    const instanceName = req.query.instance;
    
    if (!instanceName) {
        return res.json([]);
    }
    
    const instancePath = path.join(__dirname, 'files', 'instances', instanceName);
    
    console.log(`🔍 Scan instance: ${instanceName}`);
    
    if (!fs.existsSync(instancePath)) {
        console.log(`❌ Instance non trouvée: ${instancePath}`);
        return res.json([]);
    }

    // Fonction pour scanner les fichiers
    function scanDirectory(dir, basePath = '') {
        const results = [];
        
        try {
            const items = fs.readdirSync(dir);
            
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const relativePath = basePath ? `${basePath}/${item}` : item;
                
                try {
                    const stats = fs.statSync(fullPath);
                    
                    if (stats.isDirectory()) {
                        // Scanner les sous-dossiers
                        const subItems = scanDirectory(fullPath, relativePath);
                        results.push(...subItems);
                    } else {
                        // CRITIQUE : Pour les assets Minecraft, utiliser l'URL Mojang
                        // Pour les autres fichiers, utiliser notre serveur
                        let fileUrl;
                        
                        // Vérifier si c'est un asset Minecraft (hash SHA1)
                        if (item.length === 40 && /^[0-9a-f]{40}$/.test(item) && 
                            relativePath.includes('assets/objects/')) {
                            // Asset Minecraft -> utiliser URL Mojang directement
                            const prefix = item.substring(0, 2);
                            fileUrl = `https://resources.download.minecraft.net/${prefix}/${item}`;
                        } else {
                            // Autre fichier -> utiliser notre serveur
                            fileUrl = `https://${req.get('host')}/files/instances/${instanceName}/${relativePath.replace(/\\/g, '/')}`;
                        }
                        
                        results.push({
                            name: item,
                            path: relativePath.replace(/\\/g, '/'),
                            size: stats.size,
                            url: fileUrl,
                            type: 'file',
                            modified: stats.mtime.toISOString()
                        });
                    }
                } catch (error) {
                    console.log(`⚠️ Erreur fichier ${item}: ${error.message}`);
                }
            }
        } catch (error) {
            console.log(`⚠️ Erreur dossier ${dir}: ${error.message}`);
        }
        
        return results;
    }

    try {
        const files = scanDirectory(instancePath);
        console.log(`✅ ${files.length} fichiers trouvés`);
        
        // CRITIQUE : Retourner directement le tableau
        res.json(files);
        
    } catch (error) {
        console.error('❌ Erreur scan:', error);
        res.status(500).json([]);
    }
});

// Route INTELLIGENTE pour servir les fichiers avec fallback sur Mojang
app.get('/files/instances/:instance/*', (req, res) => {
    const instanceName = req.params.instance;
    const filePath = req.params[0];
    const fullPath = path.join(__dirname, 'files', 'instances', instanceName, filePath);
    
    console.log(`📤 Demande fichier: ${filePath}`);
    
    // Vérifier si c'est un asset Minecraft (hash SHA1)
    const filename = path.basename(filePath);
    const isMinecraftAsset = filename.length === 40 && /^[0-9a-f]{40}$/.test(filename) && 
                             filePath.includes('assets/objects/');
    
    // Fonction pour servir depuis notre serveur
    const serveFromOurServer = () => {
        if (fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            
            // Vérifier si le fichier n'est pas vide
            if (stats.size > 0) {
                console.log(`✅ Servi depuis notre serveur: ${stats.size} bytes`);
                
                // Gérer les requêtes Range (téléchargements partiels)
                const range = req.headers.range;
                if (range) {
                    const parts = range.replace(/bytes=/, "").split("-");
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
                    
                    const chunksize = (end - start) + 1;
                    const file = fs.createReadStream(fullPath, { start, end });
                    
                    res.writeHead(206, {
                        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunksize,
                        'Content-Type': 'application/octet-stream'
                    });
                    
                    file.pipe(res);
                } else {
                    // Téléchargement complet
                    res.sendFile(fullPath);
                }
                return true;
            } else {
                console.log(`⚠️ Fichier vide (0 bytes), fallback sur Mojang`);
                return false;
            }
        }
        return false;
    };
    
    // Fonction pour servir depuis Mojang (proxy)
    const serveFromMojang = () => {
        if (!isMinecraftAsset) {
            console.log(`❌ Ce n'est pas un asset Minecraft, impossible de proxy`);
            return false;
        }
        
        const prefix = filename.substring(0, 2);
        const mojangUrl = `https://resources.download.minecraft.net/${prefix}/${filename}`;
        
        console.log(`🌐 Proxy vers Mojang: ${mojangUrl}`);
        
        return new Promise((resolve) => {
            https.get(mojangUrl, (mojangResponse) => {
                if (mojangResponse.statusCode === 200) {
                    console.log(`✅ Mojang: ${mojangResponse.statusCode}, ${mojangResponse.headers['content-length']} bytes`);
                    
                    // Streamer vers le client
                    res.writeHead(mojangResponse.statusCode, {
                        'Content-Type': mojangResponse.headers['content-type'] || 'application/octet-stream',
                        'Content-Length': mojangResponse.headers['content-length']
                    });
                    
                    mojangResponse.pipe(res);
                    
                    // Sauvegarder localement pour les prochaines fois
                    const localDir = path.dirname(fullPath);
                    if (!fs.existsSync(localDir)) {
                        fs.mkdirSync(localDir, { recursive: true });
                    }
                    
                    const fileStream = fs.createWriteStream(fullPath);
                    mojangResponse.pipe(fileStream);
                    
                    fileStream.on('finish', () => {
                        fileStream.close();
                        console.log(`💾 Sauvegardé localement: ${filePath}`);
                    });
                    
                    resolve(true);
                } else {
                    console.log(`❌ Mojang: ${mojangResponse.statusCode}`);
                    resolve(false);
                }
            }).on('error', (error) => {
                console.error(`❌ Erreur proxy Mojang: ${error.message}`);
                resolve(false);
            });
        });
    };
    
    // Stratégie de fallback intelligente
    const serveFile = async () => {
        // 1. Essayer notre serveur d'abord
        if (serveFromOurServer()) {
            return;
        }
        
        // 2. Si échec et c'est un asset Minecraft, essayer Mojang
        if (isMinecraftAsset) {
            const mojangSuccess = await serveFromMojang();
            if (mojangSuccess) {
                return;
            }
        }
        
        // 3. Tout a échoué
        console.log(`❌ Fichier non trouvé: ${filePath}`);
        res.status(404).json({
            error: 'Fichier non trouvé',
            path: filePath,
            tried: ['Serveur local', isMinecraftAsset ? 'Mojang' : 'Non applicable']
        });
    };
    
    serveFile().catch(error => {
        console.error('❌ Erreur serveur:', error);
        res.status(500).json({ error: 'Erreur interne du serveur' });
    });
});

// Route pour pré-télécharger les assets problématiques
app.get('/prefetch-assets', async (req, res) => {
    const instanceName = req.query.instance || 'zendariom';
    const specificAssets = req.query.assets ? req.query.assets.split(',') : [];
    
    console.log(`🔄 Pré-téléchargement assets pour: ${instanceName}`);
    
    // Liste des assets connus problématiques
    const problemAssets = specificAssets.length > 0 ? specificAssets : [
        '5cca35534cc2ee3529d39b7ccc12b437955e0683',
        '5df4a02b1ebc550514841fddb7d64b9c497d40b4',
        '5cd1caeb2b7c35e58c57a90eed97be8cd893e499',
        '5c39dec69b8093f9accf712fe21f9f8bae102991',
        '5cb45773f1d399db399d0214efc75f3ade0f81d5',
        '5c971029d9284676dce1dda2c9d202f8c47163b2'
    ];
    
    const results = [];
    
    for (const asset of problemAssets) {
        const prefix = asset.substring(0, 2);
        const mojangUrl = `https://resources.download.minecraft.net/${prefix}/${asset}`;
        const localPath = path.join(__dirname, 'files', 'instances', instanceName, 'assets', 'objects', prefix, asset);
        
        // Vérifier si déjà présent
        if (fs.existsSync(localPath)) {
            const stats = fs.statSync(localPath);
            if (stats.size > 0) {
                results.push({ asset, status: 'déjà présent', size: stats.size });
                continue;
            }
        }
        
        // Télécharger depuis Mojang
        try {
            const success = await downloadFromMojang(asset, localPath);
            results.push({ 
                asset, 
                status: success ? 'téléchargé' : 'échec',
                url: mojangUrl
            });
            
            // Pause pour éviter de surcharger
            await new Promise(resolve => setTimeout(resolve, 100));
            
        } catch (error) {
            results.push({ asset, status: 'erreur', error: error.message });
        }
    }
    
    res.json({
        instance: instanceName,
        total: problemAssets.length,
        results: results
    });
});

// Fonction utilitaire pour télécharger depuis Mojang
function downloadFromMojang(hash, outputPath) {
    return new Promise((resolve, reject) => {
        const prefix = hash.substring(0, 2);
        const url = `https://resources.download.minecraft.net/${prefix}/${hash}`;
        
        // Créer le dossier si nécessaire
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        const file = fs.createWriteStream(outputPath);
        
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(outputPath);
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                resolve(true);
            });
            
        }).on('error', (error) => {
            file.close();
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
            }
            reject(error);
        });
        
        // Timeout
        setTimeout(() => {
            file.close();
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
            }
            reject(new Error('Timeout'));
        }, 30000);
    });
}

// Route de vérification
app.get('/check-file/:hash', (req, res) => {
    const hash = req.params.hash;
    const prefix = hash.substring(0, 2);
    
    const localPath = path.join(__dirname, 'files', 'instances', 'zendariom', 'assets', 'objects', prefix, hash);
    const mojangUrl = `https://resources.download.minecraft.net/${prefix}/${hash}`;
    const ourUrl = `https://${req.get('host')}/files/instances/zendariom/assets/objects/${prefix}/${hash}`;
    
    const existsLocally = fs.existsSync(localPath);
    let localSize = 0;
    
    if (existsLocally) {
        const stats = fs.statSync(localPath);
        localSize = stats.size;
    }
    
    res.json({
        hash: hash,
        local: {
            exists: existsLocally,
            size: localSize,
            path: localPath
        },
        urls: {
            our_server: ourUrl,
            mojang: mojangUrl
        },
        test: `curl -I "${ourUrl}"`
    });
});

// Page d'accueil avec infos
app.get('/', (req, res) => {
    res.json({
        server: 'Terra File Server avec fallback Mojang',
        features: [
            '📁 Liste des fichiers: /files?instance=zendariom',
            '📦 Proxy automatique vers Mojang pour les assets manquants',
            '🔍 Vérifier un fichier: /check-file/HASH',
            '🔄 Pré-télécharger: /prefetch-assets?instance=zendariom'
        ],
        example: {
            liste_fichiers: `https://${req.get('host')}/files?instance=zendariom`,
            check_probleme: `https://${req.get('host')}/check-file/5cca35534cc2ee3529d39b7ccc12b437955e0683`,
            prefetch: `https://${req.get('host')}/prefetch-assets?instance=zendariom`
        },
        note: 'Les assets Minecraft sont automatiquement proxy vers resources.download.minecraft.net si manquants localement'
    });
});

// Gestion des erreurs
app.use((error, req, res, next) => {
    console.error('🔥 Erreur:', error);
    res.status(500).json({ 
        error: 'Erreur interne',
        message: error.message 
    });
});

// Démarrer le serveur
app.listen(port, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║          SERVEUR AVEC FALLBACK AUTOMATIQUE MOJANG           ║
╚══════════════════════════════════════════════════════════════╝
📡 Port: ${port}
🌐 URL: http://localhost:${port}

🎯 FONCTIONNALITÉS:
   ✅ Liste des fichiers au format correct (tableau [])
   🔄 Proxy automatique vers Mojang pour les assets manquants
   💾 Cache local des assets téléchargés
   📊 Monitoring des fichiers problématiques

🔗 ROUTES:
   /files?instance=zendariom          → Liste des fichiers
   /check-file/:hash                  → Vérifier un fichier
   /prefetch-assets?instance=zendariom → Pré-télécharger les assets
   /files/instances/zendariom/*       → Télécharger un fichier

📝 NOTE: Si un asset Minecraft est manquant localement, il sera
         automatiquement téléchargé depuis les serveurs Mojang
         et sauvegardé localement pour les prochaines fois.
`);
});
