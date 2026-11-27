package be.keypharm.rfid;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.HybridBinarizer;

import java.io.IOException;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@SuppressWarnings("deprecation")
public final class CameraBarcodeActivity extends Activity implements SurfaceHolder.Callback {
    private static final int CAMERA_PERMISSION = 1;
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final MultiFormatReader reader = new MultiFormatReader();
    private SurfaceHolder preview;
    private Camera camera;
    private int previewWidth;
    private int previewHeight;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        TextView prompt = new TextView(this);
        prompt.setText("Aim the camera at the product barcode");
        prompt.setGravity(Gravity.CENTER);
        prompt.setPadding(16, 24, 16, 24);
        layout.addView(prompt);
        SurfaceView surface = new SurfaceView(this);
        layout.addView(surface, new LinearLayout.LayoutParams(-1, 0, 1));
        Button cancel = new Button(this);
        cancel.setText("Cancel");
        cancel.setOnClickListener(view -> finish());
        layout.addView(cancel);
        preview = surface.getHolder();
        preview.addCallback(this);
        setContentView(layout);
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request != CAMERA_PERMISSION) return;
        if (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED) {
            fail("Camera permission is needed to scan the barcode.");
        } else openCamera();
    }

    @Override protected void onResume() {
        super.onResume();
        openCamera();
    }

    @Override public void surfaceCreated(SurfaceHolder holder) { openCamera(); }
    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { }
    @Override public void surfaceDestroyed(SurfaceHolder holder) { releaseCamera(); }

    private void openCamera() {
        if (camera != null || isFinishing() || preview == null || !preview.getSurface().isValid() ||
                checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        try {
            camera = Camera.open();
            Camera.Parameters params = camera.getParameters();
            params.setPreviewFormat(ImageFormat.NV21);
            if (params.getSupportedFocusModes() != null &&
                    params.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            camera.setParameters(params);
            Camera.Size size = camera.getParameters().getPreviewSize();
            previewWidth = size.width;
            previewHeight = size.height;
            camera.setDisplayOrientation(90);
            camera.setPreviewDisplay(preview);
            camera.startPreview();
            camera.setOneShotPreviewCallback(this::readFrame);
        } catch (IOException | RuntimeException error) {
            releaseCamera();
            fail("The camera could not be opened for barcode scanning.");
        }
    }

    private void readFrame(byte[] frame, Camera source) {
        if (source != camera || frame == null || previewWidth <= 0 || previewHeight <= 0) return;
        int width = previewWidth;
        int height = previewHeight;
        int expected = width * height;
        if (frame.length < expected) return;
        byte[] luminance = Arrays.copyOf(frame, expected);
        decoder.execute(() -> {
            String value = decode(luminance, width, height);
            if (value == null) {
                byte[] rotated = new byte[luminance.length];
                for (int y = 0; y < height; y++) {
                    for (int x = 0; x < width; x++) {
                        rotated[x * height + height - 1 - y] = luminance[y * width + x];
                    }
                }
                value = decode(rotated, height, width);
            }
            String result = value;
            runOnUiThread(() -> {
                if (source != camera || isFinishing()) return;
                if (result == null || result.isBlank()) source.setOneShotPreviewCallback(this::readFrame);
                else {
                    setResult(RESULT_OK, new Intent().putExtra("barcode", result));
                    finish();
                }
            });
        });
    }

    private String decode(byte[] pixels, int width, int height) {
        PlanarYUVLuminanceSource image = new PlanarYUVLuminanceSource(pixels, width, height, 0, 0, width, height, false);
        try {
            return reader.decode(new BinaryBitmap(new HybridBinarizer(image))).getText();
        } catch (NotFoundException noBarcode) {
            return null;
        }
    }

    private void fail(String message) {
        setResult(RESULT_CANCELED, new Intent().putExtra("message", message));
        finish();
    }

    private void releaseCamera() {
        Camera active = camera;
        camera = null;
        if (active == null) return;
        try {
            active.setPreviewCallback(null);
            active.stopPreview();
        } finally {
            active.release();
        }
    }

    @Override protected void onPause() {
        releaseCamera();
        super.onPause();
    }

    @Override protected void onDestroy() {
        decoder.shutdownNow();
        super.onDestroy();
    }
}
