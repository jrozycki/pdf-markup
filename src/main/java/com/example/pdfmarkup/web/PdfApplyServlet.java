package com.example.pdfmarkup.web;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.logging.Level;
import java.util.logging.Logger;

import com.example.pdfmarkup.model.EditSpec;
import com.example.pdfmarkup.service.BusinessException;
import com.example.pdfmarkup.service.PdfEditService;

import javax.servlet.ServletException;
import javax.servlet.annotation.MultipartConfig;
import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.Part;

/**
 * Receives the PDF(s) the user opened plus the edit description, applies it, and streams the
 * result back. Nothing is stored: uploads and the result only exist for the length of the
 * request.
 *
 * <p>
 * Request (multipart/form-data): {@code spec} (JSON), {@code filename} (optional),
 * {@code pdf0}, {@code pdf1}, ... (the files; pdf0 is the base document).
 * </p>
 */
@WebServlet(name = "PdfApplyServlet", urlPatterns = "/api/pdf/apply")
@MultipartConfig(fileSizeThreshold = 8 * 1024 * 1024, maxFileSize = 300L * 1024 * 1024,
        maxRequestSize = 600L * 1024 * 1024)
public class PdfApplyServlet extends HttpServlet {

    private static final long serialVersionUID = 1L;
    private static final Logger LOG = Logger.getLogger(PdfApplyServlet.class.getName());

    /** Browsers cannot add this header on a cross-site form post, which blocks simple CSRF. */
    static final String REQUIRED_HEADER = "X-Requested-With";
    static final String REQUIRED_HEADER_VALUE = "pdf-markup";

    private static final int MAX_FILES = 50;
    private static final int MAX_SPEC_CHARS = 20 * 1024 * 1024;

    private final transient PdfEditService service = new PdfEditService();

    @Override
    protected void doPost(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {
        if (!REQUIRED_HEADER_VALUE.equals(request.getHeader(REQUIRED_HEADER))) {
            sendError(response, HttpServletResponse.SC_FORBIDDEN, "Request not allowed.");
            return;
        }

        Path result = Files.createTempFile("pdf-markup-", ".pdf");
        List<InputStream> inputs = new ArrayList<>();
        try {
            String specJson = request.getParameter("spec");
            if (specJson != null && specJson.length() > MAX_SPEC_CHARS) {
                throw new BusinessException("The edit request is too large.");
            }
            EditSpec spec = SpecParser.parse(specJson);
            if (spec.isStamp()) {
                spec.setStampText(stampText(request));
            }

            for (int i = 0; i < MAX_FILES; i++) {
                Part part = request.getPart("pdf" + i);
                if (part == null) {
                    break;
                }
                inputs.add(part.getInputStream());
            }

            try (OutputStream out = Files.newOutputStream(result)) {
                service.apply(spec, inputs, out);
            }

            response.setContentType("application/pdf");
            response.setHeader("Content-Disposition", "attachment; filename=\""
                    + safeFileName(request.getParameter("filename")) + "\"");
            response.setHeader("Cache-Control", "no-store");
            response.setContentLengthLong(Files.size(result));
            try (OutputStream out = response.getOutputStream()) {
                Files.copy(result, out);
            }
        } catch (BusinessException e) {
            sendError(response, 422, e.getMessage());
        } catch (IllegalStateException e) {
            // thrown by the container when an upload exceeds the configured size limits
            LOG.log(Level.WARNING, "Upload rejected", e);
            sendError(response, 413, "The file is too large.");
        } catch (RuntimeException e) {
            LOG.log(Level.SEVERE, "Applying PDF edits failed", e);
            sendError(response, HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
                    "The PDF could not be processed.");
        } finally {
            for (InputStream in : inputs) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // nothing useful to do
                }
            }
            Files.deleteIfExists(result);
        }
    }

    private static String stampText(HttpServletRequest request) {
        String user = request.getRemoteUser();
        String when = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"));
        return user == null ? "Marked up " + when : "Marked up by " + user + " " + when;
    }

    /** Keeps the download name plain ASCII so it cannot break the header. */
    static String safeFileName(String requested) {
        String name = requested == null ? "" : requested.replaceAll("[^A-Za-z0-9._ -]", "_").trim();
        if (name.isEmpty()) {
            name = "document_marked";
        }
        if (name.length() > 120) {
            name = name.substring(0, 120);
        }
        return name.toLowerCase().endsWith(".pdf") ? name : name + ".pdf";
    }

    private static void sendError(HttpServletResponse response, int status, String message)
            throws IOException {
        if (response.isCommitted()) {
            return;
        }
        response.reset();
        response.setStatus(status);
        response.setContentType("application/json");
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        String escaped = message.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", " ");
        response.getWriter().write("{\"message\":\"" + escaped + "\"}");
    }
}
