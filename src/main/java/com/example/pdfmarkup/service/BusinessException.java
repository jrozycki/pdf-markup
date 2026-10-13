package com.example.pdfmarkup.service;

/**
 * Thrown by the service layer for problems the user can act on (bad file, invalid page
 * reference, and so on). The message is safe to show to the user.
 */
public class BusinessException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public BusinessException(String message) {
        super(message);
    }

    public BusinessException(String message, Throwable cause) {
        super(message, cause);
    }
}
