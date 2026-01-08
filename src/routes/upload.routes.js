const router = require('express').Router();
const multer = require('multer');
const { uploadToCloudinary, deleteFromCloudinary } = require('../config/cloudinary');
const { auth, requireOrg } = require('../middlewares/auth.middleware');

const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/xml', 'application/xml'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido'), false);
    }
  }
});

// POST /api/upload - Subir archivo
router.post('/', auth, requireOrg, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó archivo' });
    }

    const { folder, resource_type } = req.body;

    const result = await uploadToCloudinary(req.file.buffer, {
      folder: `truno/${req.organization.id}/${folder || 'general'}`,
      resource_type: resource_type || 'auto',
      public_id: `${Date.now()}_${req.file.originalname.replace(/\.[^/.]+$/, '')}`
    });

    res.json({
      url: result.secure_url,
      public_id: result.public_id,
      format: result.format,
      size: result.bytes
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/upload/multiple - Subir múltiples archivos
router.post('/multiple', auth, requireOrg, upload.array('files', 10), async (req, res, next) => {
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'No se proporcionaron archivos' });
    }

    const { folder } = req.body;

    const uploads = await Promise.all(
      req.files.map(file => 
        uploadToCloudinary(file.buffer, {
          folder: `truno/${req.organization.id}/${folder || 'general'}`,
          public_id: `${Date.now()}_${file.originalname.replace(/\.[^/.]+$/, '')}`
        })
      )
    );

    res.json(uploads.map(r => ({
      url: r.secure_url,
      public_id: r.public_id,
      format: r.format,
      size: r.bytes
    })));
  } catch (error) {
    next(error);
  }
});

// DELETE /api/upload/:publicId - Eliminar archivo
router.delete('/:publicId', auth, requireOrg, async (req, res, next) => {
  try {
    const publicId = decodeURIComponent(req.params.publicId);
    
    // Verificar que el archivo pertenece a la organización
    if (!publicId.includes(req.organization.id)) {
      return res.status(403).json({ error: 'No tienes permiso para eliminar este archivo' });
    }

    await deleteFromCloudinary(publicId);
    res.json({ message: 'Archivo eliminado' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
