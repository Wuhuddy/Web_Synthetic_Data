# Defect Augmentation Tool

A web-based tool for pasting defect regions from labeled source images onto background images, with real-time transform and color adjustment.

## Features

- Drag a rectangle on the canvas to set where to paste a defect
- The defect automatically scales to fit the selected area
- Real-time sliders for Scale, Rotation, Shear, Brightness, Contrast, Hue, Saturation
- Save composite results with auto-increment filenames (no overwrites)
- Browse 53 source images, each with LabelMe polygon annotations
- Multi-paste: paste multiple defects on the same background, undo last paste
- Keyboard shortcuts: ← → navigate backgrounds, Ctrl+S save, Esc cancel selection

## Quick Start

```bash
pip install -r requirements.txt

python server.py --data-dir "E:/Download/cv_result/cv_result/raw/inpocket-gen"
```

Then open **http://localhost:50053** in your browser.

## Data Directory Format

The `--data-dir` should contain pairs of `.png` images + `.json` LabelMe annotations:

```
mydata/
├── image_001.png
├── image_001.json    # LabelMe format with polygon shapes
├── image_002.png
├── image_002.json
└── ...
```

## Options

| Argument | Default | Description |
|----------|---------|-------------|
| `--data-dir` | (required) | Path to images + JSON annotations |
| `--output-dir` | `./output/` | Where composite results are saved |
| `--port` | `50053` | Server port |

Or use environment variables: `AUGMENT_DATA_DIR`, `AUGMENT_OUTPUT_DIR`, `AUGMENT_PORT`.

## Usage

1. Select a **background** image from the left panel
2. Add **templates** by clicking defect labels (FM/mold/scratch) in the right panel
3. Select a **template** from the template library
4. **Drag** on the canvas to draw a rectangle — defect auto-fits inside
5. Adjust **sliders** (Scale, Rotation, Color) — preview updates live
6. Click **Save Paste** to lock the paste
7. Repeat steps 3-6 to paste multiple defects on the same background
8. Click **Save** in the toolbar to write the result to disk
