/* Matchmaking with room codes (net_match.c), as the lobby in net.c uses it. */
#ifndef NET_MATCH_H
#define NET_MATCH_H

#define MATCH_ADDRS 4

typedef struct MatchStatus {
    int state;                      /* 0 idle, 1 working, 2 the room is made (code), 3 the other player is known, -1 failed */
    char code[8];
    char error[96];                 /* for the window, when state is -1 */
    char peerName[20];
    char peerAddr[MATCH_ADDRS][64]; /* "ip:port", best first */
    int peerCount;
} MatchStatus;

void Match_Begin(int role, int sock, int localPort, const char *code, const char *name, int version);
void Match_Poll(MatchStatus *out);
void Match_Cancel(void);

#endif
