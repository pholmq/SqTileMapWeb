#include <stdint.h>
#include <stddef.h>
#include "Z80-support.h"
#include "Z80.h"

#define ROOM_COUNT 512
#define ROOM_W 256
#define ROOM_H 144
#define FRAME_CYCLES 70000
#define CYCLES_BEFORE_INT (FRAME_CYCLES - 32)
#define BREAKPOINT 0x64

typedef struct {
  Z80 cpu;
  uint8_t mem[65536];
  int room;
  int drawing;
  int running;
  int dirty;
  int frame_cycles;
  int visited;
  volatile int lock;
} Room;

static Room rooms[ROOM_COUNT];
static int current_room = 8;
static uint8_t key_matrix[8] = {255,255,255,255,255,255,255,255};
static int initialized = 0;
static int hook_error = 0;
static int cheat_mode = 0;
static int game_over = 0;
static uint8_t *snapshot_mem;
static uint8_t base_mem[65536];
static ZZ80State snapshot_cpu;
static uint32_t audio_events[4096];
static volatile int audio_count = 0;
static int audio_overflow = 0;
static volatile int audio_last = 0;

#define DEBUG_WRITE_CAPACITY 4096
typedef struct {
  uint16_t pc;
  uint16_t address;
  uint16_t frame_cycle;
  uint8_t before;
  uint8_t after;
} DebugWrite;
static DebugWrite debug_writes[DEBUG_WRITE_CAPACITY];
static volatile uint32_t debug_write_count = 0;

static const uint16_t hook_addresses[] = {0x672d,0xa45f,0xa475,0xd9cb,0xd9ce,0xc747,0xc35e,0xcbdc,0xa774,0xc462};
static const uint8_t hook_opcodes[]   = {0xcd,  0xcd,  0xcd,  0xcd,  0xcd,  0x3a,  0x21,  0x7a,  0x21,  0x35};

static void copy_bytes(uint8_t *dst, const uint8_t *src, size_t n) {
  for (size_t i=0;i<n;i++) dst[i]=src[i];
}
static void zero_bytes(uint8_t *dst, size_t n) {
  for (size_t i=0;i<n;i++) dst[i]=0;
}
static uint16_t peek16(Room *r, uint16_t a) {
  return (uint16_t)(r->mem[a] | ((uint16_t)r->mem[(uint16_t)(a+1)] << 8));
}
static void poke16(Room *r, uint16_t a, uint16_t v) {
  r->mem[a]=(uint8_t)v; r->mem[(uint16_t)(a+1)]=(uint8_t)(v>>8);
}
static void push16(Room *r, uint16_t v) {
  Z_Z80_STATE_SP(&r->cpu.state)=(uint16_t)(Z_Z80_STATE_SP(&r->cpu.state)-2);
  poke16(r,Z_Z80_STATE_SP(&r->cpu.state),v);
}
static void ret_cpu(Room *r) {
  uint16_t sp=Z_Z80_STATE_SP(&r->cpu.state);
  Z_Z80_STATE_PC(&r->cpu.state)=peek16(r,sp);
  Z_Z80_STATE_SP(&r->cpu.state)=(uint16_t)(sp+2);
}
static void lock_room(Room *r) { while(__atomic_exchange_n(&r->lock,1,__ATOMIC_ACQUIRE)) { } }
static void unlock_room(Room *r) { __atomic_store_n(&r->lock,0,__ATOMIC_RELEASE); }
static void clone_room(Room *from, Room *to) {
  if (from==to) return;
  lock_room(to);
  copy_bytes(to->mem,from->mem,65536);
  to->cpu.state=from->cpu.state;
  to->dirty=1;
  unlock_room(to);
}
static void clone_room_for_entry(Room *from, Room *to, uint16_t room) {
  if (from==to) return;
  lock_room(to);
  copy_bytes(to->mem,from->mem,65536);
  to->cpu.state=from->cpu.state;
  poke16(to,0xd2c8,room);
  to->dirty=0;
  to->drawing=0;
  to->visited=1;
  unlock_room(to);
}
static void clone_all(Room *from) {
  for(int i=0;i<ROOM_COUNT;i++) {
    rooms[i].visited=0;
    if(&rooms[i]!=from) clone_room(from,&rooms[i]);
  }
  from->visited=1;
}
static int is_active(Room *r) { return r->room==__atomic_load_n(&current_room,__ATOMIC_SEQ_CST); }
static uint8_t mem_read(void *ctx, uint16_t address) {
  Room *r=(Room*)ctx; return r->mem[address];
}
static void mem_write(void *ctx, uint16_t address, uint8_t value) {
  Room *r=(Room*)ctx;
  if(address>=0x4000) {
    uint8_t before=r->mem[address];
    if(is_active(r)) {
      uint32_t index=__atomic_fetch_add(&debug_write_count,1,__ATOMIC_SEQ_CST);
      DebugWrite *entry=&debug_writes[index % DEBUG_WRITE_CAPACITY];
      entry->pc=Z_Z80_STATE_PC(&r->cpu.state);
      entry->address=address;
      entry->frame_cycle=(uint16_t)(r->frame_cycles + (int)r->cpu.cycles);
      entry->before=before;
      entry->after=value;
    }
    r->mem[address]=value;
    if(address<0x5b00) r->dirty=1;
  }
}
static uint8_t port_in(void *ctx, uint16_t address) {
  Room *r=(Room*)ctx;
  if(!is_active(r)) return 0xff;
  uint8_t value=0xff;
  for(int i=0;i<8;i++) if(!(address & (1u << (8+i)))) value &= key_matrix[i];
  return value;
}
static void port_out(void *ctx, uint16_t address, uint8_t value) {
  Room *r=(Room*)ctx;
  if(is_active(r) && (address & 0xff)==0xfe) {
    uint32_t cycle=(uint32_t)(r->frame_cycles + (int)r->cpu.cycles);
    int index=__atomic_fetch_add(&audio_count,1,__ATOMIC_SEQ_CST);
    if(index<4096) audio_events[index]=(cycle<<8) | value; else audio_overflow=1;
    __atomic_store_n(&audio_last,value,__ATOMIC_SEQ_CST);
  }
}
static uint32_t int_data(void *ctx) { (void)ctx; return 0xffff; }

static void on_hook(void *ctx, uint16_t address) {
  Room *r=(Room*)ctx;
  uint8_t original=0;
  uint16_t life_address=Z_Z80_STATE_HL(&r->cpu.state);
  uint8_t life_before=r->mem[life_address];
  int found=0;
  for(int i=0;i<(int)(sizeof(hook_addresses)/sizeof(hook_addresses[0]));i++) {
    if(hook_addresses[i]==address) { original=hook_opcodes[i]; found=1; break; }
  }
  if(!found) { Z_Z80_STATE_PC(&r->cpu.state)++; r->cpu.cycles+=4; return; }

  r->mem[address]=original;
  size_t old_cycles=r->cpu.cycles;
  z80_run(&r->cpu,1);
  r->cpu.cycles += old_cycles;
  r->mem[address]=BREAKPOINT;

  switch(address) {
    case 0x672d:
      if(is_active(r)) {
        clone_all(r);
        __atomic_store_n(&current_room,8,__ATOMIC_SEQ_CST);
        /* TileMap centres the view on room 24 after starting. */
      }
      break;
    case 0xa45f: {
      uint16_t new_room=peek16(r,0xd2c8);
      if(is_active(r) && new_room<ROOM_COUNT && new_room!=r->room) {
        Room *next=&rooms[new_room];
        r->visited=1;
        /* Seed a room only on its first visit; revisits keep their own CPU and RAM. */
        if(!next->visited) clone_room_for_entry(r,next,new_room);
        __atomic_store_n(&current_room,new_room,__ATOMIC_SEQ_CST);
      }
      r->drawing=0;
      poke16(r,0xd2c8,(uint16_t)r->room);
      break;
    }
    case 0xa475:
      r->drawing=1;
      r->dirty=1;
      break;
    case 0xd9cb:
    case 0xd9ce:
      if(!is_active(r) && r->room!=199) ret_cpu(r);
      break;
    case 0xc747:
      if(!is_active(r)) Z_Z80_STATE_PC(&r->cpu.state)++;
      break;
    case 0xc35e:
      if(!is_active(r)) ret_cpu(r);
      break;
    case 0xcbdc:
      if(!is_active(r)) Z_Z80_STATE_A(&r->cpu.state)=0;
      break;
    case 0xa774:
      if(!is_active(r)) Z_Z80_STATE_PC(&r->cpu.state)=0xa759;
      break;
    case 0xc462:
      /* DEC (HL) is Starquake's lives-decrement instruction. */
      if(is_active(r) && life_before==1 && r->mem[life_address]==0) game_over=1;
      break;
  }
}

static void run_one_frame(Room *r) {
  r->frame_cycles=0;
  r->frame_cycles+=(int)z80_run(&r->cpu,CYCLES_BEFORE_INT);
  z80_int(&r->cpu,1);
  r->frame_cycles+=(int)z80_run(&r->cpu,32);
  z80_int(&r->cpu,0);
  r->frame_cycles-=FRAME_CYCLES;
}

/* SNA loader. ROM is the 16K Spectrum 48K ROM; SNA is the 27-byte header + 48K RAM. */
int emu_init(const uint8_t *sna, int sna_len, const uint8_t *rom, int rom_len, int cheats) {
  if(!sna || sna_len!=49179 || !rom || rom_len<16384) return -1;
  zero_bytes((uint8_t*)&snapshot_cpu,sizeof(snapshot_cpu));
  snapshot_mem=(uint8_t*)0; /* no heap allocation; seed each room directly below */
  uint8_t *base=base_mem; zero_bytes(base,65536);
  copy_bytes(base,rom,16384);
  copy_bytes(base+0x4000,sna+27,49152);

  Z_Z80_STATE_I(&snapshot_cpu)=sna[0];
  Z_Z80_STATE_HL_(&snapshot_cpu)=(uint16_t)(sna[1]|(sna[2]<<8));
  Z_Z80_STATE_DE_(&snapshot_cpu)=(uint16_t)(sna[3]|(sna[4]<<8));
  Z_Z80_STATE_BC_(&snapshot_cpu)=(uint16_t)(sna[5]|(sna[6]<<8));
  Z_Z80_STATE_AF_(&snapshot_cpu)=(uint16_t)(sna[7]|(sna[8]<<8));
  Z_Z80_STATE_HL(&snapshot_cpu)=(uint16_t)(sna[9]|(sna[10]<<8));
  Z_Z80_STATE_DE(&snapshot_cpu)=(uint16_t)(sna[11]|(sna[12]<<8));
  Z_Z80_STATE_BC(&snapshot_cpu)=(uint16_t)(sna[13]|(sna[14]<<8));
  Z_Z80_STATE_IY(&snapshot_cpu)=(uint16_t)(sna[15]|(sna[16]<<8));
  Z_Z80_STATE_IX(&snapshot_cpu)=(uint16_t)(sna[17]|(sna[18]<<8));
  Z_Z80_STATE_IFF1(&snapshot_cpu)=(sna[19]&4)?1:0;
  Z_Z80_STATE_IFF2(&snapshot_cpu)=Z_Z80_STATE_IFF1(&snapshot_cpu);
  Z_Z80_STATE_EI(&snapshot_cpu)=Z_Z80_STATE_IFF2(&snapshot_cpu);
  Z_Z80_STATE_R(&snapshot_cpu)=sna[20];
  Z_Z80_STATE_AF(&snapshot_cpu)=(uint16_t)(sna[21]|(sna[22]<<8));
  Z_Z80_STATE_SP(&snapshot_cpu)=(uint16_t)(sna[23]|(sna[24]<<8));
  Z_Z80_STATE_IM(&snapshot_cpu)=sna[25]&3;
  Z_Z80_STATE_PC(&snapshot_cpu)=(uint16_t)(base[Z_Z80_STATE_SP(&snapshot_cpu)] | (base[(uint16_t)(Z_Z80_STATE_SP(&snapshot_cpu)+1)]<<8));
  Z_Z80_STATE_SP(&snapshot_cpu)=(uint16_t)(Z_Z80_STATE_SP(&snapshot_cpu)+2);
  Z_Z80_STATE_IRQ(&snapshot_cpu)=0; Z_Z80_STATE_NMI(&snapshot_cpu)=0; Z_Z80_STATE_HALT(&snapshot_cpu)=0;

  /* Starquake-specific patches used by Simon Owen's implementation. */
  base[0x6024]=0x3e;
  base[0xda33]=0x3e;
  base[0xc561]=0x18;
  base[0x5c78]=0x5a; base[0x5c79]=0xa5;
  if(cheats) { base[0xc462]=0; base[0xd41f]=0xc9; base[0xce8e]=0x18; base[0xd735]=0; }

  for(int i=0;i<(int)(sizeof(hook_addresses)/sizeof(hook_addresses[0]));i++) {
    /* The infinite-lives cheat replaces DEC (HL) at 0xC462, so do not hook it. */
    if(hook_addresses[i]==0xc462 && cheats) continue;
    if(base[hook_addresses[i]]!=hook_opcodes[i]) return -2-(int)i;
    base[hook_addresses[i]]=BREAKPOINT;
  }

  for(int i=0;i<ROOM_COUNT;i++) {
    Room *r=&rooms[i];
    copy_bytes(r->mem,base,65536);
    z80_power(&r->cpu,1);
    z80_reset(&r->cpu);
    r->cpu.state=snapshot_cpu;
    r->cpu.context=r;
    r->cpu.read=mem_read; r->cpu.write=mem_write;
    r->cpu.in=port_in; r->cpu.out=port_out; r->cpu.int_data=int_data;
    r->cpu.halt=0; r->cpu.hook=on_hook;
    r->room=i; r->drawing=1; r->running=1; r->dirty=1; r->frame_cycles=0; r->visited=0; r->lock=0;
    r->cpu.cycles=0;
  }
  current_room=8; initialized=1; hook_error=0; game_over=0; audio_count=0; audio_last=0; debug_write_count=0;
  for(int i=0;i<8;i++) key_matrix[i]=0xff;
  return 0;
}

void emu_set_key_row(int row, int value) { if(row>=0 && row<8) key_matrix[row]=(uint8_t)value; }
void emu_tick_range(int start_room, int end_room, int max_frames_per_room, int frame_number, int background_divisor, int min_col, int max_col, int min_row, int max_row) {
  if(!initialized) return;
  if(start_room<0) start_room=0;
  if(end_room>ROOM_COUNT) end_room=ROOM_COUNT;
  if(max_frames_per_room<1) max_frames_per_room=1;
  if(max_frames_per_room>50) max_frames_per_room=50;
  if(background_divisor<1) background_divisor=1;
  for(int i=start_room;i<end_room;i++) {
    Room *r=&rooms[i];
    int col=i%16, row=i/16;
    int visible=(col>=min_col && col<=max_col && row>=min_row && row<=max_row);
    int active=is_active(r);
    int visited_background=!active && !visible && r->visited && ((frame_number + i) % 5 == 0);
    if(!active && !visible && !visited_background) continue;
    lock_room(r);
    if(r->running && (active || (visible && (!r->drawing || frame_number % background_divisor == 0)) || visited_background)) {
      int frames=visited_background ? (r->drawing ? 1 : max_frames_per_room) : max_frames_per_room;
      for(int f=0;f<frames;f++) {
        run_one_frame(r);
        if(r->drawing) break;
      }
    }
    unlock_room(r);
  }
}
void emu_tick(int max_frames_per_room) { emu_tick_range(0,ROOM_COUNT,max_frames_per_room,0,1,0,15,0,31); }
void emu_begin_frame(void) { __atomic_store_n(&audio_count,0,__ATOMIC_SEQ_CST); audio_overflow=0; }

int emu_current_room(void) { return current_room; }
int emu_game_over(void) { return game_over; }
int emu_room_dirty(int room) { return (room>=0&&room<ROOM_COUNT)?rooms[room].dirty:0; }
void emu_clear_dirty(int room) { if(room>=0&&room<ROOM_COUNT) rooms[room].dirty=0; }
int emu_take_dirty(int room) { if(room<0||room>=ROOM_COUNT) return 0; return __atomic_exchange_n(&rooms[room].dirty,0,__ATOMIC_SEQ_CST); }
int emu_screen_ptr(int room) { if(room<0||room>=ROOM_COUNT) return 0; return (int)(uintptr_t)(rooms[room].mem+0x4000); }
int emu_room_pc(int room) { return (room>=0&&room<ROOM_COUNT)?Z_Z80_STATE_PC(&rooms[room].cpu.state):0; }
int emu_room_sp(int room) { return (room>=0&&room<ROOM_COUNT)?Z_Z80_STATE_SP(&rooms[room].cpu.state):0; }
int emu_room_id(int room) { return (room>=0&&room<ROOM_COUNT)?rooms[room].room:-1; }
int emu_audio_count(void) { return __atomic_load_n(&audio_count,__ATOMIC_SEQ_CST); }
int emu_audio_ptr(void) { return (int)(uintptr_t)audio_events; }
int emu_audio_overflowed(void) { return audio_overflow; }
int emu_audio_last(void) { return __atomic_load_n(&audio_last,__ATOMIC_SEQ_CST); }
int emu_is_initialized(void) { return initialized; }
int emu_room_count(void) { return ROOM_COUNT; }

/* Diagnostic exports: active-room RAM, CPU state and recent RAM writes. */
int emu_debug_ram_ptr(void) { return (int)(uintptr_t)(rooms[current_room].mem+0x4000); }
int emu_debug_pc(void) { return Z_Z80_STATE_PC(&rooms[current_room].cpu.state); }
int emu_debug_sp(void) { return Z_Z80_STATE_SP(&rooms[current_room].cpu.state); }
int emu_debug_write_ptr(void) { return (int)(uintptr_t)debug_writes; }
int emu_debug_write_count(void) { return (int)__atomic_load_n(&debug_write_count,__ATOMIC_SEQ_CST); }
int emu_debug_write_capacity(void) { return DEBUG_WRITE_CAPACITY; }
void emu_debug_clear_writes(void) { __atomic_store_n(&debug_write_count,0,__ATOMIC_SEQ_CST); }

void *memcpy(void *dst, const void *src, size_t n) { uint8_t *d=(uint8_t*)dst; const uint8_t *s=(const uint8_t*)src; for(size_t i=0;i<n;i++) d[i]=s[i]; return dst; }
void *memset(void *dst, int v, size_t n) { uint8_t *d=(uint8_t*)dst; for(size_t i=0;i<n;i++) d[i]=(uint8_t)v; return dst; }
