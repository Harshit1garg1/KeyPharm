package be.keypharm.rfid;

import android.content.res.AssetManager;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;

final class DashboardServer implements AutoCloseable {
    private static final int PORT = 8787;
    private static final Map<String,String> FILES = Map.of(
            "", "dashboard.html", "dashboard.mjs", "dashboard.mjs",
            "dashboard-model.mjs", "dashboard-model.mjs", "dashboard.css", "dashboard.css",
            "keypharm-logo-hd.png", "keypharm-logo-hd.png");
    private final AssetManager assets;
    private final Supplier<String> snapshot;
    private final String path = "/" + UUID.randomUUID() + "/";
    private final ServerSocket listener;
    private volatile boolean running = true;

    DashboardServer(AssetManager assets, Supplier<String> snapshot) throws IOException {
        this.assets = assets;
        this.snapshot = snapshot;
        listener = new ServerSocket();
        try {
            listener.setReuseAddress(true);
            listener.bind(new InetSocketAddress(PORT));
        } catch (IOException error) {
            listener.close();
            throw error;
        }
        new Thread(this::listen, "keypharm-dashboard").start();
    }

    String url() throws SocketException {
        for (NetworkInterface network : java.util.Collections.list(NetworkInterface.getNetworkInterfaces())) {
            if (!network.isUp() || !network.getName().startsWith("wlan")) continue;
            for (InetAddress address : java.util.Collections.list(network.getInetAddresses())) {
                if (address instanceof Inet4Address) return "http://" + address.getHostAddress() + ":" + PORT + path;
            }
        }
        return "http://127.0.0.1:" + PORT + path;
    }

    private void listen() {
        while (running) {
            try (Socket socket = listener.accept()) {
                socket.setSoTimeout(1500);
                reply(socket);
            } catch (IOException ignored) { }
        }
    }

    private void reply(Socket socket) throws IOException {
        InputStream incoming = socket.getInputStream();
        String request = line(incoming);
        String[] parts = request.split(" ");
        if (parts.length != 3) return;
        // Drain browser headers before closing the response connection.
        for (int i = 0; i < 64; i++) if (line(incoming).isEmpty()) break;
        String status = "404 Not Found", type = "text/plain; charset=utf-8";
        byte[] body = "Page not found".getBytes(StandardCharsets.UTF_8);
        if (!"GET".equals(parts[0])) {
            status = "405 Method Not Allowed";
            body = "Read-only dashboard".getBytes(StandardCharsets.UTF_8);
        } else if (parts[1].startsWith(path)) {
            String route = parts[1].substring(path.length());
            if ("records".equals(route)) {
                status = "200 OK";
                type = "application/json; charset=utf-8";
                body = snapshot.get().getBytes(StandardCharsets.UTF_8);
            } else if (FILES.containsKey(route)) {
                String file = FILES.get(route);
                try (InputStream asset = assets.open(file)) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buffer = new byte[4096];
                    for (int n; (n = asset.read(buffer)) != -1;) out.write(buffer, 0, n);
                    body = out.toByteArray();
                }
                status = "200 OK";
                type = file.endsWith(".png") ? "image/png" :
                        (file.endsWith(".mjs") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html") + "; charset=utf-8";
            }
        }
        OutputStream output = socket.getOutputStream();
        output.write(("HTTP/1.1 " + status + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-store\r\nConnection: close\r\nReferrer-Policy: no-referrer\r\n"
                + "X-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; frame-ancestors 'none'\r\n\r\n")
                .getBytes(StandardCharsets.US_ASCII));
        output.write(body);
        output.flush();
    }

    private String line(InputStream in) throws IOException {
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < 4096; i++) {
            int c = in.read();
            if (c == -1 || c == '\n') return result.toString();
            if (c != '\r') result.append((char) c);
        }
        throw new IOException("Request line too long");
    }

    @Override public void close() {
        running = false;
        try { listener.close(); } catch (IOException ignored) { }
    }
}
