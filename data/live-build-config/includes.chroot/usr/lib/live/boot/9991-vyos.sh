#!/bin/sh
# VyOS additions to Debian's live-boot.
#
# live-boot's frontend (/usr/bin/live-boot) sources /etc/live/boot.conf,
# /etc/live/boot/* and then every /lib/live/boot/????-* component in glob
# order. This file sorts after all upstream 9990-* components, so it is
# sourced last and may both set variables and redefine functions.
#
# It exists so that VyOS does not have to fork the live-boot source package.
# Everything below is either a translation of VyOS-specific kernel command
# line parameters, or a copy of an upstream function with a clearly marked
# deviation. The copies are taken verbatim from bookworm's
# /usr/lib/live/boot/9990-misc-helpers.sh (live-boot 1:20230131) - when
# bumping live-boot, re-sync them. The
# hooks/live/08-live-boot-vyos.chroot build hook fails the ISO build if they
# have drifted.
#
# Deviations that are candidates for upstreaming:
#   * get_custom_mounts()        honour persistence-path= for source=
#   * mount_persistence_media()  skip devices that are MD RAID members
#   * what_is_mounted_on()       keep the boot medium eligible for persistence
#
# Note: this file is sourced *before* Live() runs, and Cmdline_old() only
# assigns a variable when the matching token is absent from the kernel command
# line, so plain assignment here is not overwritten later.

# ---------------------------------------------------------------------------
# VyOS kernel command line parameters
# ---------------------------------------------------------------------------
# vyos-union=<path> (and its pre-1.2 alias vyatta-union=) is shorthand for the
# set of stock live-boot parameters that describe a VyOS image installed to
# disk. It is still emitted by vyos-1x (python/vyos/system/grub.py,
# BOOT_OPTS_STEM) and by grub entries written by older releases, so it has to
# be understood indefinitely.
for _PARAMETER in $(cat /proc/cmdline)
do
	case "${_PARAMETER}" in
		vyos-union=*|vyatta-union=*)
			LIVE_MEDIA_PATH="${_PARAMETER#*=}"
			PERSISTENCE_PATH="${LIVE_MEDIA_PATH}/"
			PERSISTENCE="true"
			NONETWORKING="true"
			UNIONTYPE="overlay"
			export LIVE_MEDIA_PATH PERSISTENCE_PATH PERSISTENCE \
			       NONETWORKING UNIONTYPE
			;;
	esac
done
unset _PARAMETER

# ---------------------------------------------------------------------------
# Overrides of upstream functions
# ---------------------------------------------------------------------------

# VyOS puts the boot medium and the persistence filesystem on the *same*
# partition: /boot/<version>/<version>.squashfs is the medium content, and
# boot/<version>/rw is the overlay upper directory.
#
# Upstream's find_persistence_media() blacklists whatever device is mounted at
# /run/live/medium, on the reasoning that using it for persistence could union a
# parent directory on top of one of its own sub-directories. VyOS avoids that by
# scoping the union to ${PERSISTENCE_PATH} (see get_custom_mounts() above), so
# the medium has to stay eligible - otherwise persistence is never found and the
# system silently boots on a tmpfs overlay with an empty configuration.
#
# Debian live-boot 1:20151213, the base of the old VyOS fork, did not blacklist
# the medium and also passed a literal "d" instead of "${d}" to this function,
# so its blacklist was always empty. Both were fixed upstream; that fix is what
# makes stock live-boot incompatible with the VyOS on-disk layout.
#
# Rather than copy the whole 60-line find_persistence_media(), keep upstream's
# blacklist mechanism intact and make just the medium resolve to no device. The
# only other callers pass a custom-mount destination below ${rootmnt}, which can
# never be /run/live/medium - get_custom_mounts() rejects /run/live paths
# outright.
what_is_mounted_on ()
{
	local dir
	dir="$(trim_path ${1})"

	if [ "${dir}" = "/run/live/medium" ]
	then
		return 0
	fi

	grep -m1 "^[^ ]\+ ${dir} " /proc/mounts | cut -d' ' -f1
}

mount_persistence_media ()
{
	local device probe backing old_backing fstype mount_opts
	local raid_drives raid_drive disks disk occupant
	device=${1}
	probe=${2}

	# get_custom_mounts() might call this with a directory path instead
	# of a block device path. This means we have found sub-directory path
	# underneath /run/live/persistence, so we're done
	if [ -d "${device}" ]
	then
		echo "${device}"
		return 0
	fi

	if [ ! -b "${device}" ]
	then
		return 1
	fi

	# VyOS: never mount a member of an assembled MD RAID directly - doing so
	# would give us a second, inconsistent view of the same filesystem.
	raid_drives=$(awk '{ if ($4 != "name") { print $4 } }' /proc/partitions \
			| grep "^md" || true)
	for raid_drive in ${raid_drives}
	do
		disks=$(ls /sys/block/${raid_drive}/slaves 2>/dev/null || true)
		for disk in ${disks}
		do
			if [ "/dev/${disk}" = "${device}" ]
			then
				return 1
			fi
		done
	done

	# VyOS: flat backing directory, without the per-device sub-directory that
	# upstream uses. VyOS boots a single persistence partition and addresses
	# every image below it as boot/<version>/rw; the persistence root must
	# therefore be at a fixed, device-independent path.
	backing="/run/live/persistence"

	# A flat backing directory can hold only one device. Upstream's per-device
	# sub-directory makes a second persistence device harmless; here it would
	# be mounted straight on top of the first, shadowing it, and the custom
	# mounts would then be read from whichever device happened to be scanned
	# last. Refuse the later device instead and keep the first one.
	occupant="$(what_is_mounted_on "${backing}")"
	if [ -n "${occupant}" ] && [ "${occupant}" != "${device}" ]
	then
		[ -z "${probe}" ] && log_warning_msg \
			"Ignoring persistence media ${device}: ${occupant} is already mounted on ${backing}"
		return 1
	fi

	mkdir -p "${backing}"
	old_backing="$(where_is_mounted ${device})"
	if [ -z "${old_backing}" ]
	then
		fstype="$(get_fstype ${device})"
		mount_opts="rw,noatime"
		if [ -n "${PERSISTENCE_READONLY}" ]
		then
			mount_opts="ro,noatime"
		fi
		if mount -t "${fstype}" -o "${mount_opts}" "${device}" "${backing}" >/dev/null 2>&1
		then
			echo ${backing}
			return 0
		else
			[ -z "${probe}" ] && log_warning_msg "Failed to mount persistence media ${device}"
			rmdir "${backing}"
			return 1
		fi
	elif [ "${backing}" != "${old_backing}" ]
	then
		if ! mount -o move ${old_backing} ${backing} >/dev/null
		then
			[ -z "${probe}" ] && log_warning_msg "Failed to move persistence media ${device}"
			rmdir "${backing}"
			return 1
		fi
		mount_opts="rw,noatime"
		if [ -n "${PERSISTENCE_READONLY}" ]
		then
			mount_opts="ro,noatime"
		fi
		if ! mount -o "remount,${mount_opts}" "${backing}" >/dev/null
		then
			log_warning_msg "Failed to remount persistence media ${device} writable"
			# Don't unmount or rmdir the new mountpoint in this case
		fi
		echo ${backing}
		return 0
	else
		# This means that $device has already been mounted on
		# the place expected by live-boot, so we're done.
		echo ${backing}
		return 0
	fi
}

get_custom_mounts ()
{
	# Side-effect: leaves $devices with persistence.conf mounted in /run/live/persistence
	# Side-effect: prints info to file $custom_mounts

	local custom_mounts devices bindings links
	custom_mounts=${1}
	shift
	devices=${@}

	bindings="/tmp/bindings.list"
	links="/tmp/links.list"
	rm -rf ${bindings} ${links} 2> /dev/null

	for device in ${devices}
	do
		local device_name backing include_list
		device_name="$(basename ${device})"
		backing=$(mount_persistence_media ${device})
		if [ -z "${backing}" ]
		then
			continue
		fi

		if [ -r "${backing}/${persistence_list}" ]
		then
			include_list="${backing}/${persistence_list}"
		else
			continue
		fi

		if [ -n "${LIVE_BOOT_DEBUG}" ] && [ -e "${include_list}" ]
		then
			cp ${include_list} /run/live/persistence/${persistence_list}.${device_name}
		fi

		while read dir options # < ${include_list}
		do
			if echo ${dir} | grep -qe "^[[:space:]]*\(#.*\)\?$"
			then
				# skipping empty or commented lines
				continue
			fi

			if trim_path ${dir} | grep -q -e "^[^/]" -e "^/lib" -e "^/run/live\(/.*\)\?$" -e "^/\(.*/\)\?\.\.\?\(/.*\)\?$"
			then
				log_warning_msg "Skipping unsafe custom mount ${dir}: must be an absolute path containing neither the \".\" nor \"..\" special dirs, and cannot be \"/lib\", or \"/run/live\" or any of its sub-directories."
				continue
			fi

			local opt_source opt_link source full_source full_dest
			opt_source=""
			opt_link=""
			for opt in $(echo ${options} | tr ',' ' ');
			do
				case "${opt}" in
					source=*)
						opt_source=${opt#source=}
						;;
					link)
						opt_link="true"
						;;
					union|bind)
						;;
					*)
						log_warning_msg "Skipping custom mount with unknown option: ${opt}"
						continue 2
						;;
				esac
			done

			source="${dir}"
			if [ -n "${opt_source}" ]
			then
				if echo ${opt_source} | grep -q -e "^/" -e "^\(.*/\)\?\.\.\?\(/.*\)\?$" && [ "${opt_source}" != "." ]
				then
					log_warning_msg "Skipping unsafe custom mount with option source=${opt_source}: must be either \".\" (the media root) or a relative path w.r.t. the media root that contains neither comas, nor the special \".\" and \"..\" path components"
					continue
				else
					source="${opt_source}"
				fi
			fi

			# VyOS: resolve source= relative to persistence-path=, so that
			# a single persistence.conf at the partition root serves every
			# installed image (boot/<version>/rw). Upstream ignores
			# PERSISTENCE_PATH here; see the note at the top of this file.
			full_source="$(trim_path ${backing}/${PERSISTENCE_PATH}/${source})"
			full_dest="$(trim_path ${rootmnt}/${dir})"
			if [ -n "${opt_link}" ]
			then
				echo "${device} ${full_source} ${full_dest} ${options}" >> ${links}
			else
				echo "${device} ${full_source} ${full_dest} ${options}" >> ${bindings}
			fi
		done < ${include_list}
	done

	# We sort the list according to destination so we're sure that
	# we won't hide a previous mount. We also ignore duplicate
	# destinations in a more or less arbitrary way.
	[ -e "${bindings}" ] && sort -k3 -sbu ${bindings} >> ${custom_mounts} && rm ${bindings}

	# After all mounts are considered we add symlinks so they
	# won't be hidden by some mount.
	[ -e "${links}" ] && cat ${links} >> ${custom_mounts} && rm ${links}

	# We need to make sure that no two custom mounts have the same sources
	# or are nested; if that is the case, too much weird stuff can happen.
	local prev_source prev_dest
	prev_source="impossible source" # first iteration must not match
	prev_dest=""
	# This sort will ensure that a source /a comes right before a source
	# /a/b so we only need to look at the previous source
	[ -e ${custom_mounts} ] && sort -k2 -b ${custom_mounts} |
	while read device source dest options
	do
		if echo ${source} | grep -qe "^${prev_source}\(/.*\)\?$"
		then
			panic "Two persistence mounts have the same or nested sources: ${source} on ${dest}, and ${prev_source} on ${prev_dest}"
		fi
		prev_source=${source}
		prev_dest=${dest}
	done
}
