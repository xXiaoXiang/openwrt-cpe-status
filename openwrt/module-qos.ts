// Temporary helper copied into module /tmp by the OpenWrt plugin over ADB.
// It never sends AT, toggles RF, redials, or writes module persistent files.
// Perl is already installed on the tested RM500Q firmware; no npm/runtime needed.
export const moduleQosCollector = String.raw`#!/usr/bin/perl
use strict;
use warnings;
use IO::Socket::INET;
use IO::Select;
use Fcntl qw(:flock);

umask 0077;
my $dir = $ENV{CPE_QOS_DIR} || '/tmp/cpe-status-qos';
my $limit = $ENV{CPE_QOS_TIMEOUT} || 90;
$limit = 90 unless $limit =~ /^\d+$/ && $limit >= 10 && $limit <= 120;
my ($socket, $listener, $logger, $backup, $bits, $changed, $stop) = (undef, undef, undef, undef, 0, 0, 0);
my ($pending, $escape, $invalid_crc, $frame_count, $raw_bytes) = ('', 0, 0, 0, 0);
my ($boot, $last_data, $start, @sessions) = ('', 0, 0);
my @packets;
sub text { my ($path) = @_; open my $fh, '<', $path or return ''; local $/; my $s = <$fh>; close $fh; $s =~ s/\s+$//; return $s; }
sub monotonic { return 0 + (split /\s+/, text('/proc/uptime'))[0]; }
sub json_string { my ($s) = @_; $s = '' unless defined $s; $s =~ s/(["\\])/\\$1/g; $s =~ s/([\x00-\x1f])/sprintf('\\u%04x',ord($1))/eg; return '"'.$s.'"'; }
sub json {
  my ($v) = @_;
  return 'null' unless defined $v;
  return '['.join(',',map { json($_) } @$v).']' if ref($v) eq 'ARRAY';
  return '{'.join(',',map { json_string($_).':'.json($v->{$_}) } sort keys %$v).'}' if ref($v) eq 'HASH';
  return $v if $v =~ /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
  return json_string($v);
}
sub save {
  my ($name, $value) = @_;
  open my $fh, '>', "$dir/$name.tmp" or die "write $name: $!";
  print $fh json($value), "\n"; close $fh or die "close $name: $!";
  rename "$dir/$name.tmp", "$dir/$name" or die "rename $name: $!";
}
sub status {
  my ($state, $reason) = @_;
  save('status.json', { schema_version=>1, boot_id=>$boot, run_id=>$ENV{CPE_QOS_RUN_ID} || '', status=>$state, reason=>$reason, started_uptime=>$start, updated_uptime=>monotonic(), frame_count=>$frame_count, invalid_crc=>$invalid_crc });
  print "$state: $reason\n";
}
sub crc {
  my ($s) = @_; my $crc = 0xffff;
  for my $byte (unpack 'C*', $s) { $crc ^= $byte; for (1..8) { $crc = ($crc & 1) ? (($crc >> 1)^0x8408) : ($crc >> 1); } }
  return $crc ^ 0xffff;
}
sub encode {
  my ($s) = @_; $s .= pack('v',crc($s));
  $s =~ s/([\x7d\x7e])/"\x7d".chr(ord($1)^0x20)/eg;
  return $s."\x7e";
}
sub write_all {
  my ($s) = @_; my $offset = 0;
  while ($offset < length $s) { my $n = syswrite($socket,$s,length($s)-$offset,$offset); die 'DIAG write failed' unless $n; $offset += $n; }
}
sub request { my ($op,@values) = @_; return pack('C4V*',0x73,0,0,0,$op,@values); }
sub mask_request { my ($mask) = @_; return request(3,11,$bits).$mask; }
sub rate {
  my ($base,$extended,$extended2) = @_;
  my $n = $base >= 128 && $base <= 254 ? 576+($base-128)*64 : $base >= 64 && $base <= 127 ? 64+($base-64)*8 : $base >= 1 && $base <= 63 ? $base : $base == 255 ? 0 : undef;
  if (defined $extended && $extended != 0) {
    $n = $extended <= 74 ? 8600+$extended*100 : $extended <= 186 ? 16000+($extended-74)*1000 : $extended <= 250 ? 128000+($extended-186)*2000 : 256000;
  }
  $n += $extended2*256000 if defined $n && defined $extended2 && $extended2 >= 1 && $extended2 <= 254;
  return $n;
}
sub bearer {
  my ($payload) = @_; return if length($payload) < 9;
  my $nas = substr($payload,4); my @n = unpack 'C*',$nas;
  return unless ($n[0]&15) == 2 && $n[2] == 0xc1 && $n[3] >= 1 && 4+$n[3] < @n;
  my $qci = $n[4]; return unless $qci >= 1;
  my $pos = 4+$n[3]; my $end = $pos+1+$n[$pos++]; return if $end > @n;
  my @labels;
  while ($pos < $end) {
    my $len = $n[$pos++]; return unless $len && $pos+$len <= $end;
    my $label = substr($nas,$pos,$len); return unless $label =~ /^[a-zA-Z0-9-]+$/;
    push @labels,$label; $pos += $len;
  }
  return if $pos >= @n || $pos+1+$n[$pos] > @n;
  $pos += 1+$n[$pos]; # PDN address LV
  my ($dl,$ul,$raw);
  while ($pos < @n) {
    my $tag = $n[$pos];
    if (($tag&0xf0)==0x80 || ($tag&0xf0)==0x90 || ($tag&0xf0)==0xb0 || ($tag&0xf0)==0xc0) { $pos++; next; }
    if ($tag==0x32 || $tag==0x58) { $pos+=2; next; }
    last if $pos+1 >= @n;
    my $wide = $tag==0x7b; last if $wide && $pos+2 >= @n;
    my $len = $wide ? ($n[$pos+1]*256+$n[$pos+2]) : $n[$pos+1];
    my $value = $pos+($wide?3:2); last if $value+$len > @n;
    if ($tag==0x5e && ($len==2 || $len==4 || $len==6)) {
      $dl=rate($n[$value],$len>=4?$n[$value+2]:undef,$len>=6?$n[$value+4]:undef);
      $ul=rate($n[$value+1],$len>=4?$n[$value+3]:undef,$len>=6?$n[$value+5]:undef);
      $raw=unpack('H*',substr($nas,$value,$len));
      last; # QoS is complete; never guess later optional NAS IE layouts.
    }
    $pos=$value+$len;
  }
  my $apn = join('.',@labels); return unless length($apn);
  my $kind = $apn =~ /^(?:ims|sos|emergency)(?:\.|$)/i ? 'other' : 'data';
  my $entry={ apn=>$apn, qci=>$qci, bearer_id=>$n[0]>>4, dl_speed=>$dl, ul_speed=>$ul, ambr_raw=>$raw, kind=>$kind, captured_uptime=>monotonic(), source=>'lte-nas-b0e2', rate_unit=>'kbit/s' };
  @sessions=grep { lc($_->{apn}) ne lc($apn) || $_->{bearer_id} != $entry->{bearer_id} } @sessions;
  push @sessions,$entry;
  if ($kind eq 'data') { $last_data=monotonic(); }
  save('result.json',{ schema_version=>1, boot_id=>$boot, run_id=>$ENV{CPE_QOS_RUN_ID} || '', status=>'ok', sessions=>\@sessions }) unless $ARGV[0] && $ARGV[0] eq '--decode';
}
sub packet {
  my ($p) = @_;
  return packet(substr($p,8)) if length($p)>=9 && ord(substr($p,0,1))==0x98;
  $frame_count++;
  if (ord(substr($p,0,1)) == 0x73) { push @packets,$p; shift @packets if @packets > 16; }
  return unless length($p)>=17 && ord(substr($p,0,1))==0x10 && unpack('v',substr($p,6,2))==0xb0e2;
  my $end = 4+unpack('v',substr($p,4,2)); $end=length($p) if $end>length($p);
  bearer(substr($p,16,$end-16)) if $end>16;
}
sub feed {
  my ($chunk) = @_;
  for my $byte (unpack 'C*',$chunk) {
    if ($byte==0x7e) {
      if (!$escape && length($pending)>=3) {
        my $p=substr($pending,0,-2);
        if (crc($p)==unpack('v',substr($pending,-2))) { packet($p); } else { $invalid_crc++; }
      }
      $pending=''; $escape=0;
    } elsif ($escape) { $pending.=chr($byte^0x20); $escape=0; }
    elsif ($byte==0x7d) { $escape=1; }
    else { $pending.=chr($byte); }
    die 'oversized DIAG frame' if length($pending)>1048576;
  }
}
my $rawfh;
sub receive {
  my ($timeout) = @_;
  return unless IO::Select->new($socket)->can_read($timeout);
  my $chunk=''; my $n=sysread($socket,$chunk,65536); die 'DIAG socket closed' unless $n;
  $raw_bytes += $n; die 'DIAG capture size limit' if $raw_bytes>2*1024*1024;
  print $rawfh $chunk if $rawfh;
  feed($chunk);
}
sub exchange {
  my ($p,$op) = @_;
  @packets=(); write_all(encode($p)); my $until=monotonic()+4;
  while (monotonic()<$until) {
    receive(0.2);
    for my $reply (@packets) { return $reply if length($reply)>=12 && unpack('V',substr($reply,4,4))==$op; }
  }
  die "DIAG operation $op timed out";
}
sub existing_logger {
  opendir my $proc,'/proc' or die $!;
  my @pids=grep { /^\d+$/ } readdir($proc); closedir $proc;
  for my $pid (@pids) {
    my $cmd=text("/proc/$pid/cmdline"); my ($name)=split /\0/,$cmd; next unless defined $name;
    return 1 if $name =~ m{(?:^|/)(?:diag_socket_log|diag_mdlog|qllog)$};
  }
  return 0;
}
if (($ARGV[0]||'') eq '--stop') {
  my $wanted=$ARGV[1] || '';
  die 'invalid collector run' unless $wanted =~ /^\d+-\d+$/;
  my ($status,$owner)=(text("$dir/status.json"),text("$dir/collector.pid"));
  if ($status =~ /"run_id"\s*:\s*"\Q$wanted\E"/ && $owner =~ /^[1-9]\d*$/
      && text("/proc/$owner/cmdline") =~ m{(?:^|\0)/tmp/cpe-status-qos-collector\.pl(?:\0|$)}) {
    kill 'TERM',$owner;
    my $until=monotonic()+6;
    while (-e "/proc/$owner" && monotonic()<$until) { select undef,undef,undef,0.1; }
  }
  exit 0;
}
if (($ARGV[0]||'') eq '--decode') {
  open my $fh,'<',$ARGV[1] or die $!; binmode $fh;
  while (read($fh,my $data,65536)) { feed($data); }
  print json({ sessions=>\@sessions, frames=>$frame_count, invalid_crc=>$invalid_crc }),"\n";
  exit 0;
}
mkdir $dir,0700 unless -d $dir;
open my $lock,'>',"$dir/collector.lock" or die $!;
flock($lock,LOCK_EX|LOCK_NB) or exit 0;
open my $owner,'>',"$dir/collector.pid" or die $!;
print $owner $$; close $owner;
$boot=text('/proc/sys/kernel/random/boot_id'); $start=monotonic();
$SIG{TERM}=sub { $stop=1; }; $SIG{INT}=sub { $stop=1; };
$SIG{HUP}=sub { $stop=1; }; $SIG{ALRM}=sub { $stop=1; }; $SIG{PIPE}='IGNORE';
alarm($limit+12);
my ($error,$complete)=('',0);
eval {
  die 'another diagnostic logger is active' if existing_logger();
  die 'factory QXDM capture is enabled' if -e '/data/.qxdm_enable';
  unlink "$dir/result.json";
  status('starting','Waiting for local DIAG');
  $listener=IO::Socket::INET->new(LocalAddr=>'127.0.0.1',LocalPort=>0,Listen=>1,ReuseAddr=>1) or die $!;
  my $port=$listener->sockport();
  $logger=fork(); die 'cannot fork diag_socket_log' unless defined $logger;
  if (!$logger) {
    close $lock; close $listener;
    open STDIN,'<','/dev/null'; open STDOUT,'>',"$dir/logger.log"; open STDERR,'>&',STDOUT;
    exec '/usr/bin/diag_socket_log','-a','127.0.0.1','-p',"$port",'-r','1';
    exit 1;
  }
  die 'local DIAG connection timed out' unless IO::Select->new($listener)->can_read(8);
  $socket=$listener->accept() or die $!; $socket->autoflush(1);
  open $rawfh,'>',"$dir/diag.hdlc" or die $!; binmode $rawfh;
  my $ranges=exchange(request(1),1);
  die 'invalid DIAG ranges' unless length($ranges)>=76 && unpack('V',substr($ranges,8,4))==0;
  $bits=unpack('V',substr($ranges,56,4)); die 'invalid LTE mask length' unless $bits>=1 && $bits<=4096;
  my $old=exchange(request(4,11),4); my $bytes=int(($bits+7)/8);
  die 'cannot save current log mask' unless length($old)>=20+$bytes && unpack('V',substr($old,8,4))==0 && unpack('V',substr($old,12,4))==11 && unpack('V',substr($old,16,4))==$bits;
  $backup=substr($old,20,$bytes);
  open my $bf,'>',"$dir/original-mask.bin" or die $!; binmode $bf; print $bf $backup; close $bf;
  my $mask=$backup; vec($mask,0xe2,1)=1;
  $changed=1;
  my $enabled=exchange(mask_request($mask),3);
  die 'LTE NAS log subscription rejected' unless unpack('V',substr($enabled,8,4))==0;
  status('listening','Subscribed to LTE default-bearer NAS');
  system('/bin/systemd-notify','--ready','--status=Listening for data-bearer QoS') if $ENV{NOTIFY_SOCKET};
  while (!$stop && monotonic()-$start<$limit) {
    receive(0.3);
    if ($last_data && monotonic()-$last_data>=5) { $complete=1; last; }
  }
  1;
} or $error=$@ || 'capture failed';
my $restored= !$changed;
if ($changed && defined $backup && $socket) {
  eval { my $reply=exchange(mask_request($backup),3); die 'restore rejected' if unpack('V',substr($reply,8,4))!=0; $restored=1; 1; } or $error.=" log-mask restore: $@";
}
close $socket if $socket; close $listener if $listener; close $rawfh if $rawfh;
if ($logger) { kill 'TERM',$logger; waitpid($logger,0); }
my $outcome=$error ? 'error' : $complete ? 'complete' : $stop ? 'stopped' : 'timeout';
status($outcome,$error || ($complete ? 'Data-bearer QoS cached; collector stopped' : 'No new data-bearer QoS; no RF change requested'));
save('cleanup.json',{ mask_restored=>$restored?1:0, logger_stopped=>1, boot_id=>$boot, run_id=>$ENV{CPE_QOS_RUN_ID} || '' });
unlink "$dir/collector.pid";
exit($error?1:0);
`
