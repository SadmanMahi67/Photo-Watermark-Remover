# Photo Watermark Remover

Local, open source AI desktop app for removing watermarks from photos.

![Photo Watermark Remover Screenshot](https://github.com/user-attachments/assets/4a4ae1fc-5a79-42ad-905a-4bb70e949871)

## Features

- Fully local and offline processing (no cloud upload)
- GPU and CPU support (NVIDIA CUDA acceleration with CPU fallback)
- Brush-based masking for precise watermark targeting
- PNG and JPG export options
- Processing time shown after each run
- Fully open source

## How It Works

Photo Watermark Remover uses LaMa inpainting through IOPaint.
In simple terms, you mark the watermark area, and the model predicts what should be there by analyzing surrounding texture, color, and structure. It then reconstructs that region so it blends naturally with the rest of the image.

## Download

- Latest release: [GitHub Releases](https://github.com/SadmanMahi67/Photo-Watermark-Remover/releases/latest)
- Direct Windows installer (v0.1.0): [Photo.Watermark.Remover-0.1.0-setup.exe](https://github.com/SadmanMahi67/Photo-Watermark-Remover/releases/download/v0.1.0/Photo.Watermark.Remover-0.1.0-setup.exe)

## How to Use

1. Open an image.
2. Paint over the watermark with the mask brush.
3. Click Remove Watermark.
4. Save the result as PNG or JPG.

## System Requirements

- Windows 10 or Windows 11
- NVIDIA GPU with CUDA is optional (CPU mode supported)
- 4 GB RAM minimum

## Built With

- Electron
- React
- Python
- FastAPI
- IOPaint
- LaMa

## License

This project is open source.
