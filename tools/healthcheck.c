// Fixed loopback HTTP probe: no shell, subprocesses, DNS, TLS, or proxy support.
// One alarm bounds port parsing, connect, write and status-line reads together.
#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void expired(int signal_number) {
    (void)signal_number;
    _exit(1);
}

int main(void) {
    struct sigaction action = {0};
    action.sa_handler = expired;
    if (sigemptyset(&action.sa_mask) || sigaction(SIGALRM, &action, NULL)) return 1;
    action.sa_handler = SIG_IGN;
    if (sigaction(SIGPIPE, &action, NULL)) return 1;
    alarm(4);

    const char *value = getenv("PORT");
    unsigned port = 8080;
    if (value && *value) {
        port = 0;
        for (const char *digit = value; *digit; digit++) {
            if (*digit < '0' || *digit > '9') return 1;
            port = port * 10 + (unsigned)(*digit - '0');
            if (port > 65535) return 1;
        }
        if (!port) return 1;
    }

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 1;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons((unsigned short)port);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address))) return 1;

    char request[128];
    int length = snprintf(request, sizeof(request),
        "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:%u\r\nConnection: close\r\n\r\n", port);
    if (length < 0 || (size_t)length >= sizeof(request)) return 1;
    size_t sent = 0;
    while (sent < (size_t)length) {
        ssize_t count = send(fd, request + sent, (size_t)length - sent, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 1;
        sent += (size_t)count;
    }

    // Bound the status line and headers. Do not report success on a truncated
    // response; neither a body nor redirects can extend the work or destination.
    char response[8192];
    size_t used = 0, scanned = 0;
    int status_ok = 0;
    while (used < sizeof(response)) {
        ssize_t count = recv(fd, response + used, sizeof(response) - used, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 1;
        used += (size_t)count;
        if (!status_ok) {
            char *end = memchr(response, '\n', used);
            if (!end) {
                if (used >= 256) return 1;
                continue;
            }
            size_t line_length = (size_t)(end - response) + 1;
            if (line_length < 15 || line_length > 256 || end[-1] != '\r'
                || (memcmp(response, "HTTP/1.1 ", 9) && memcmp(response, "HTTP/1.0 ", 9))
                || response[9] != '2' || response[10] < '0' || response[10] > '9'
                || response[11] < '0' || response[11] > '9' || response[12] != ' ') return 1;
            status_ok = 1;
        }
        for (; scanned + 3 < used; scanned++) {
            if (!memcmp(response + scanned, "\r\n\r\n", 4)) {
                close(fd);
                return 0;
            }
        }
    }
    return 1;
}
