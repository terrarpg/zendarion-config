const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const port = 3000;

// Middleware pour servir les fichiers statiques
app.use('/files', express.static(path.join(__dirname, 'files')));

// Route pour la page d'accueil
app.get('/', (req, res) => res.send('Terra File Server OK - Mode Scan Complet'));

// Route PRINCIPALE - Scan COMPLET de l'instance
app.get('/files/', (req, res) => {
    const instanceName = req.query.instance;
    
    if (!instanceName) {
        return res.status(400).json([]);
    }
    
    const instancePath = path.join(__dirname, 'files', 'instances', instanceName);
    
    console.log(`Scan complet de l'instance: ${instanceName}`);
    console.log(`Chemin: ${instancePath}`);
    
    try {
        if (!fs.existsSync(instancePath)) {
            console.log(`Instance non trouvée: ${instancePath}`);
            return res.json([]);
        }

        // Fonction pour scanner RÉCURSIVEMENT tous les fichiers
        function scanAllFiles(dir, basePath = '') {
            let allFiles = [];
            
            try {
                const items = fs.readdirSync(dir);
                
                for (const item of items) {
                    const fullPath = path.join(dir, item);
                    const relativePath = path.join(basePath, item).replace(/\\/g, '/');
                    
                    try {
                        const stats = fs.statSync(fullPath);
                        
                        if (stats.isDirectory()) {
                            // Scanner récursivement le sous-dossier
                            const subFiles = scanAllFiles(fullPath, relativePath);
                            allFiles = allFiles.concat(subFiles);
                        } else {
                            // Ajouter le fichier
                            allFiles.push({
                                name: item,
                                path: relativePath,
                                size: stats.size,
                                url: `/files/instances/${instanceName}/${relativePath}`,
                                type: 'file',
                                modified: stats.mtime
                            });
                        }
                    } catch (error) {
                        console.log(`Erreur sur ${fullPath}:`, error.message);
                    }
                }
            } catch (error) {
                console.log(`Erreur lecture dossier ${dir}:`, error.message);
            }
            
            return allFiles;
        }

        // Scanner TOUS les fichiers de l'instance
        const allFiles = scanAllFiles(instancePath);
        
        console.log(`Total fichiers trouvés: ${allFiles.length}`);
        
        // Afficher les dossiers principaux pour debug
        const mainDirs = fs.readdirSync(instancePath);
        console.log(`Dossiers principaux: ${mainDirs.join(', ')}`);
        
        res.json(allFiles);
        
    } catch (error) {
        console.error('Erreur scan complet:', error);
        res.status(500).json({ error: 'Erreur scan instance' });
    }
});

// Route pour télécharger n'importe quel fichier
app.get('/files/instances/:instance/*', (req, res) => {
    const instanceName = req.params.instance;
    const filePath = req.params[0];
    
    const fullPath = path.join(__dirname, 'files', 'instances', instanceName, filePath);
    
    console.log(`Demande fichier: ${filePath}`);
    
    try {
        if (!fs.existsSync(fullPath)) {
            console.log(`Fichier non trouvé: ${fullPath}`);
            return res.status(404).json({ error: 'Fichier non trouvé: ' + filePath });
        }
        
        // Servir le fichier
        res.sendFile(fullPath);
        
    } catch (error) {
        console.error('Erreur envoi fichier:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// Route pour lister les instances disponibles
app.get('/instances', (req, res) => {
    const instancesPath = path.join(__dirname, 'files', 'instances');
    
    try {
        if (!fs.existsSync(instancesPath)) {
            return res.json({ instances: [] });
        }
        
        const instances = fs.readdirSync(instancesPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
        
        res.json({ instances });
    } catch (error) {
        res.status(500).json({ error: 'Erreur lecture instances' });
    }
});

app.listen(port, () => {
    console.log(`=== Terra File Server Démaré ===`);
    console.log(`URL: http://localhost:${port}`);
    console.log(`Dossier instances: ${path.join(__dirname, 'files', 'instances')}`);
    console.log(`Mode: SCAN COMPLET - Tous les fichiers servis`);
    console.log(`===========================================`);
    
    // Afficher les instances disponibles au démarrage
    const instancesPath = path.join(__dirname, 'files', 'instances');
    if (fs.existsSync(instancesPath)) {
        const instances = fs.readdirSync(instancesPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
        
        console.log(`Instances disponibles: ${instances.join(', ')}`);
    }
});