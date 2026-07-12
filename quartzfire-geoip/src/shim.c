/* Thin C shim over IPFire libloc for the qzgeo Rust binary.
 *
 * Everything libloc-specific — header locations, enumerator modes, FILE*
 * plumbing, string ownership — lives here, compiled against the REAL headers
 * at package build time. The Rust side only sees the qzgeo_* functions below,
 * so a libloc API change is a compile error in the deb build rather than
 * undefined behaviour at runtime.
 *
 * Only built with the `libloc` cargo feature (see build.rs); requires
 * libloc-dev.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

/* Header prefix moved from <loc/…> to <libloc/…> around libloc 0.9.8. */
#if defined(__has_include) && __has_include(<libloc/libloc.h>)
#include <libloc/libloc.h>
#include <libloc/database.h>
#include <libloc/network.h>
#include <libloc/country.h>
#else
#include <loc/libloc.h>
#include <loc/database.h>
#include <loc/network.h>
#include <loc/country.h>
#endif

struct qzgeo_db {
    struct loc_ctx *ctx;
    struct loc_database *db;
};

void *qzgeo_db_open(const char *path) {
    struct qzgeo_db *handle = calloc(1, sizeof(*handle));
    if (!handle)
        return NULL;
    if (loc_new(&handle->ctx) < 0) {
        free(handle);
        return NULL;
    }
    FILE *f = fopen(path, "re");
    if (!f) {
        loc_unref(handle->ctx);
        free(handle);
        return NULL;
    }
    int r = loc_database_new(handle->ctx, &handle->db, f);
    fclose(f);
    if (r < 0) {
        loc_unref(handle->ctx);
        free(handle);
        return NULL;
    }
    return handle;
}

void qzgeo_db_close(void *p) {
    struct qzgeo_db *handle = p;
    if (!handle)
        return;
    if (handle->db)
        loc_database_unref(handle->db);
    if (handle->ctx)
        loc_unref(handle->ctx);
    free(handle);
}

long long qzgeo_db_created_at(void *p) {
    struct qzgeo_db *handle = p;
    return (long long)loc_database_created_at(handle->db);
}

/* 1 = signature valid, 0 = invalid, -1 = key file unreadable. */
int qzgeo_db_verify(void *p, const char *keyfile) {
    struct qzgeo_db *handle = p;
    FILE *f = fopen(keyfile, "re");
    if (!f)
        return -1;
    int r = loc_database_verify(handle->db, f);
    fclose(f);
    return r == 0 ? 1 : 0;
}

typedef void (*qzgeo_net_cb)(const char *cidr, void *user);

/* Enumerate networks as CIDR strings; cc == NULL means the whole database.
 * family is 4 or 6. Returns 0 on success. Flattening/merging is done on the
 * Rust side (collapse), so no enumerator flags are needed. */
int qzgeo_db_networks(void *p, const char *cc, int family, qzgeo_net_cb cb, void *user) {
    struct qzgeo_db *handle = p;
    struct loc_database_enumerator *e = NULL;
    if (loc_database_enumerator_new(&e, handle->db, LOC_DB_ENUMERATE_NETWORKS, 0) < 0)
        return -1;
    if (cc && loc_database_enumerator_set_country_code(e, cc) < 0) {
        loc_database_enumerator_unref(e);
        return -1;
    }
    if (loc_database_enumerator_set_family(e, family == 4 ? AF_INET : AF_INET6) < 0) {
        loc_database_enumerator_unref(e);
        return -1;
    }
    struct loc_network *net = NULL;
    while (loc_database_enumerator_next_network(e, &net) == 0 && net) {
        char *s = loc_network_str(net);
        if (s) {
            cb(s, user);
            free(s);
        }
        loc_network_unref(net);
        net = NULL;
    }
    loc_database_enumerator_unref(e);
    return 0;
}

typedef void (*qzgeo_country_cb)(const char *code, const char *name,
                                 const char *continent, void *user);

int qzgeo_db_countries(void *p, qzgeo_country_cb cb, void *user) {
    struct qzgeo_db *handle = p;
    struct loc_database_enumerator *e = NULL;
    if (loc_database_enumerator_new(&e, handle->db, LOC_DB_ENUMERATE_COUNTRIES, 0) < 0)
        return -1;
    struct loc_country *country = NULL;
    while (loc_database_enumerator_next_country(e, &country) == 0 && country) {
        const char *code = loc_country_get_code(country);
        const char *name = loc_country_get_name(country);
        const char *continent = loc_country_get_continent_code(country);
        cb(code ? code : "", name ? name : "", continent ? continent : "", user);
        loc_country_unref(country);
        country = NULL;
    }
    loc_database_enumerator_unref(e);
    return 0;
}

/* 1 = found (cc/net filled; cc may be empty for an unclassified network),
 * 0 = no match, -1 = error. */
int qzgeo_db_lookup(void *p, const char *ip, char *cc_buf, size_t cc_len,
                    char *net_buf, size_t net_len) {
    struct qzgeo_db *handle = p;
    struct loc_network *net = NULL;
    int r = loc_database_lookup_from_string(handle->db, ip, &net);
    if (r < 0)
        return -1;
    if (!net)
        return 0;
    const char *code = loc_network_get_country_code(net);
    snprintf(cc_buf, cc_len, "%s", code ? code : "");
    char *s = loc_network_str(net);
    snprintf(net_buf, net_len, "%s", s ? s : "");
    free(s);
    loc_network_unref(net);
    return 1;
}
